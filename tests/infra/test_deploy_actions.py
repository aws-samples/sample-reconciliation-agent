"""The deploy-actions Lambda: polling outcomes, dispatch, and the arguments it must not drop.

The handler lives under ``infra/modules/deploy-actions/src/`` (it is deployed by Terraform, not
imported by the app), so it is loaded here by path.

Every test here is about a failure that would otherwise be SILENT. These actions replaced
`local-exec` polls whose whole value was refusing to let an apply continue past an unfinished
asynchronous operation: a KB with no documents still answers retrievals (emptily), and a gateway
target that has not reached READY advertises no tools, which fails a Cedar policy update closed and
costs the agent every read tool. An action that returned success early would reintroduce exactly the
class of bug the polls exist to prevent.
"""

import ast
import datetime
import importlib.util
import pathlib
import re
import sys

import pytest

_SRC = (
    pathlib.Path(__file__).resolve().parents[2]
    / "infra"
    / "modules"
    / "deploy-actions"
    / "src"
    / "handler.py"
)


def _load():
    """Load handler.py from its path as a module.

    :returns: the imported module object.
    """
    spec = importlib.util.spec_from_file_location("deploy_actions_handler", _SRC)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


hnd = _load()


class FakeClient:
    """A boto3 stand-in returning queued responses and recording calls."""

    def __init__(self, responses=None, start_response=None, user_pool_client=None):
        """Store the response queue.

        :param responses: list of dicts returned by successive get_* calls; the last repeats.
        :param start_response: dict returned by start_ingestion_job.
        :param user_pool_client: the ``UserPoolClient`` body describe_user_pool_client returns.
        """
        self._responses = list(responses or [])
        self._start_response = start_response
        self._user_pool_client = user_pool_client
        self.calls = []

    def _next(self):
        return self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]

    def get_data_source(self, **kw):
        self.calls.append(("get_data_source", kw))
        return self._next()

    def get_gateway_target(self, **kw):
        self.calls.append(("get_gateway_target", kw))
        return self._next()

    def start_ingestion_job(self, **kw):
        self.calls.append(("start_ingestion_job", kw))
        return self._start_response

    def get_ingestion_job(self, **kw):
        self.calls.append(("get_ingestion_job", kw))
        return self._next()

    def describe_user_pool_client(self, **kw):
        self.calls.append(("describe_user_pool_client", kw))
        return {"UserPoolClient": self._user_pool_client}

    def update_user_pool_client(self, **kw):
        self.calls.append(("update_user_pool_client", kw))
        return {}


@pytest.fixture
def patch_boto(monkeypatch):
    """Replace boto3.client with a factory returning a supplied FakeClient."""

    def install(client):
        monkeypatch.setattr(hnd.boto3, "client", lambda *a, **k: client)
        # Never actually sleep: a terminal-status test would otherwise wait out a 10-minute budget.
        monkeypatch.setattr(hnd.time, "sleep", lambda _s: None)
        return client

    return install


# --- data source readiness -------------------------------------------------------------------


def test_wait_kb_data_source_returns_once_available(patch_boto):
    client = patch_boto(
        FakeClient(
            [
                {"dataSource": {"status": "CREATING"}},
                {"dataSource": {"status": "AVAILABLE"}},
            ]
        )
    )
    assert hnd.wait_kb_data_source(knowledge_base_id="kb", data_source_id="ds") == {
        "status": "AVAILABLE"
    }
    # Polled twice: it must not accept the first non-ready status as done.
    assert len([c for c in client.calls if c[0] == "get_data_source"]) == 2


def test_wait_kb_data_source_raises_on_failed_with_the_reasons(patch_boto):
    """FAILED must raise immediately AND carry failureReasons — the status alone diagnoses nothing."""
    patch_boto(FakeClient([{"dataSource": {"status": "FAILED", "failureReasons": ["bad prefix"]}}]))
    with pytest.raises(RuntimeError, match="bad prefix"):
        hnd.wait_kb_data_source(knowledge_base_id="kb", data_source_id="ds")


def test_wait_kb_data_source_raises_on_timeout_rather_than_passing(patch_boto):
    """Budget exhaustion is a failure. Returning here would let ingestion start against CREATING."""
    patch_boto(FakeClient([{"dataSource": {"status": "CREATING"}}]))
    with pytest.raises(RuntimeError, match="timed out"):
        hnd.wait_kb_data_source(knowledge_base_id="kb", data_source_id="ds")


# --- gateway target readiness ---------------------------------------------------------------


def test_wait_gateway_target_returns_once_ready(patch_boto):
    patch_boto(FakeClient([{"status": "CREATING"}, {"status": "READY"}]))
    assert hnd.wait_gateway_target(gateway_identifier="gw", target_id="t") == {"status": "READY"}


@pytest.mark.parametrize("status", ["CREATE_FAILED", "UPDATE_FAILED", "DELETING", "FAILED"])
def test_wait_gateway_target_raises_on_each_terminal_status(patch_boto, status):
    """All four are terminal. Treating any as transient burns the budget then reports a timeout,
    hiding the statusReasons that name the real cause (an IAM gap or a wrong knowledgeBaseId)."""
    patch_boto(FakeClient([{"status": status, "statusReasons": ["nope"]}]))
    with pytest.raises(RuntimeError, match="nope"):
        hnd.wait_gateway_target(gateway_identifier="gw", target_id="t")


# --- ingestion ------------------------------------------------------------------------------


def test_start_kb_ingestion_returns_the_document_counts(patch_boto):
    """The counts are the apply's only evidence the corpus landed, so they must be returned."""
    client = patch_boto(
        FakeClient(
            responses=[
                {"ingestionJob": {"status": "IN_PROGRESS"}},
                {
                    "ingestionJob": {
                        "status": "COMPLETE",
                        "statistics": {
                            "numberOfDocumentsScanned": 15,
                            "numberOfNewDocumentsIndexed": 15,
                            "numberOfDocumentsFailed": 0,
                        },
                    }
                },
            ],
            start_response={"ingestionJob": {"ingestionJobId": "job-1"}},
        )
    )
    result = hnd.start_kb_ingestion(knowledge_base_id="kb", data_source_id="ds")
    assert result == {"job_id": "job-1", "scanned": "15", "indexed": "15", "failed": "0"}
    assert ("start_ingestion_job", {"knowledgeBaseId": "kb", "dataSourceId": "ds"}) in client.calls


def test_start_kb_ingestion_reports_a_nonzero_failed_count_without_masking_it(patch_boto):
    """COMPLETE with failures is NOT an error — but the count must survive to the apply log.

    A managed-KB job has been observed reporting COMPLETE while dropping documents, so silently
    discarding this number would erase the only signal a reader gets.
    """
    patch_boto(
        FakeClient(
            responses=[
                {
                    "ingestionJob": {
                        "status": "COMPLETE",
                        "statistics": {
                            "numberOfDocumentsScanned": 15,
                            "numberOfNewDocumentsIndexed": 10,
                            "numberOfDocumentsFailed": 5,
                        },
                    }
                }
            ],
            start_response={"ingestionJob": {"ingestionJobId": "job-2"}},
        )
    )
    assert hnd.start_kb_ingestion(knowledge_base_id="kb", data_source_id="ds")["failed"] == "5"


def test_start_kb_ingestion_raises_on_a_failed_job(patch_boto):
    patch_boto(
        FakeClient(
            responses=[{"ingestionJob": {"status": "FAILED", "failureReasons": ["boom"]}}],
            start_response={"ingestionJob": {"ingestionJobId": "job-3"}},
        )
    )
    with pytest.raises(RuntimeError, match="boom"):
        hnd.start_kb_ingestion(knowledge_base_id="kb", data_source_id="ds")


# --- the Cognito callback patch --------------------------------------------------------------
#
# ⚠️ These tests are about ONE failure: UpdateUserPoolClient REPLACES a client's configuration rather
# than merging into it, so a patch that sent only the two URL lists would strip the auth flows, the
# scopes, the token validity and the supported identity providers off a live app client. The console
# would keep working until the next token expiry and then fail with `invalid_request`, days after the
# apply that caused it and with nothing in any diff to point at. The whole design of the action -- read
# the live client, write it back with only the URLs changed -- exists for that, and it is only worth
# anything if something checks that the carry-over actually happens.


def _live_client(**overrides):
    """A DescribeUserPoolClient body shaped like the one modules/console-auth creates.

    Every field here is one UpdateUserPoolClient accepts and would drop if the patch did not carry it,
    plus the read-only ones it must NOT send back.

    :param overrides: fields to replace in the returned body.
    :returns: the ``UserPoolClient`` dict.
    """
    body = {
        # Read-only: Describe returns these, Update rejects them.
        "UserPoolId": "us-east-1_Example1",
        "ClientId": "exampleclientid",
        "CreationDate": datetime.datetime(2026, 1, 1),
        "LastModifiedDate": datetime.datetime(2026, 1, 2),
        # Configuration that must survive the patch untouched.
        "ClientName": "recon-console",
        "AllowedOAuthFlows": ["code"],
        "AllowedOAuthScopes": ["openid", "email", "profile"],
        "AllowedOAuthFlowsUserPoolClient": True,
        "ExplicitAuthFlows": ["ALLOW_REFRESH_TOKEN_AUTH"],
        "SupportedIdentityProviders": ["COGNITO"],
        "AccessTokenValidity": 60,
        "IdTokenValidity": 60,
        "RefreshTokenValidity": 1,
        "TokenValidityUnits": {
            "AccessToken": "minutes",
            "IdToken": "minutes",
            "RefreshToken": "days",
        },
        "PreventUserExistenceErrors": "ENABLED",
        "EnableTokenRevocation": True,
        # What the patch replaces: the create-time list, before the public host existed.
        "CallbackURLs": ["http://localhost:3000/callback"],
        "LogoutURLs": ["http://localhost:3000"],
    }
    body.update(overrides)
    return body


def test_patch_cognito_callbacks_replaces_the_urls_and_carries_everything_else(patch_boto):
    client = patch_boto(FakeClient(user_pool_client=_live_client()))

    result = hnd.patch_cognito_callbacks(
        user_pool_id="us-east-1_Example1",
        client_id="exampleclientid",
        callback_urls=["https://d111111abcdef8.cloudfront.net/callback", "http://localhost:3000/callback"],
        logout_urls=["https://d111111abcdef8.cloudfront.net", "http://localhost:3000"],
    )

    assert result["changed"] == "true"
    (_, described), (_, sent) = client.calls
    assert described == {"UserPoolId": "us-east-1_Example1", "ClientId": "exampleclientid"}

    # The two lists are what the caller asked for...
    assert sent["CallbackURLs"] == [
        "https://d111111abcdef8.cloudfront.net/callback",
        "http://localhost:3000/callback",
    ]
    assert sent["LogoutURLs"] == ["https://d111111abcdef8.cloudfront.net", "http://localhost:3000"]

    # ...and EVERY other field of the live client came back unchanged. Compared as a whole dict rather
    # than field by field, so a field added to console-auth and dropped by the patch fails here.
    carried = {k: v for k, v in _live_client().items() if k not in {"CallbackURLs", "LogoutURLs"}}
    read_only = {"CreationDate", "LastModifiedDate"}
    for name, value in carried.items():
        if name in read_only:
            continue
        assert sent[name] == value, f"the patch changed or dropped {name}"


def test_patch_cognito_callbacks_does_not_send_the_read_only_fields_back(patch_boto):
    """Describe returns them; Update rejects them, and boto3 would fail the apply on the request."""
    client = patch_boto(FakeClient(user_pool_client=_live_client(ClientSecret="not-a-real-secret")))

    hnd.patch_cognito_callbacks(
        user_pool_id="us-east-1_Example1",
        client_id="exampleclientid",
        callback_urls=["https://console.example.test/callback"],
        logout_urls=["https://console.example.test"],
    )

    (_, sent) = client.calls[1]
    assert "ClientSecret" not in sent
    assert "CreationDate" not in sent
    assert "LastModifiedDate" not in sent
    # The two identifiers ARE required by Update, so they are set explicitly rather than carried.
    assert sent["UserPoolId"] == "us-east-1_Example1"
    assert sent["ClientId"] == "exampleclientid"


def test_patch_cognito_callbacks_writes_nothing_when_the_urls_already_match(patch_boto):
    """Order is not significant to Cognito, so a re-ordered list is not a change to write."""
    client = patch_boto(
        FakeClient(
            user_pool_client=_live_client(
                CallbackURLs=["https://console.example.test/callback", "http://localhost:3000/callback"],
                LogoutURLs=["https://console.example.test", "http://localhost:3000"],
            )
        )
    )

    result = hnd.patch_cognito_callbacks(
        user_pool_id="us-east-1_Example1",
        client_id="exampleclientid",
        callback_urls=["http://localhost:3000/callback", "https://console.example.test/callback"],
        logout_urls=["http://localhost:3000", "https://console.example.test"],
    )

    assert result["changed"] == "false"
    assert [name for name, _ in client.calls] == ["describe_user_pool_client"]


@pytest.mark.parametrize(
    ("callbacks", "logouts"),
    [
        ([], ["https://console.example.test"]),
        (["https://console.example.test/callback"], []),
    ],
)
def test_patch_cognito_callbacks_refuses_to_write_an_empty_list(patch_boto, callbacks, logouts):
    """Cognito accepts an empty list, and the result is a client no browser can sign in through."""
    client = patch_boto(FakeClient(user_pool_client=_live_client()))

    with pytest.raises(ValueError, match="non-empty"):
        hnd.patch_cognito_callbacks(
            user_pool_id="us-east-1_Example1",
            client_id="exampleclientid",
            callback_urls=callbacks,
            logout_urls=logouts,
        )
    # Refused BEFORE reading anything, so a bad input cannot half-apply.
    assert client.calls == []


def test_patch_cognito_callbacks_is_reachable_through_handle(patch_boto):
    """The action name in infra/environments/recon/main.tf's `input` must dispatch.

    It did not: the invocation shipped before the action did, so a default apply failed on an unknown
    action after the pool, the client, the container build, the ECS service, the ALB and CloudFront had
    all landed.
    """
    client = patch_boto(FakeClient(user_pool_client=_live_client()))

    result = hnd.handle(
        {
            "action": "patch_cognito_callbacks",
            "user_pool_id": "us-east-1_Example1",
            "client_id": "exampleclientid",
            "callback_urls": ["https://console.example.test/callback"],
            "logout_urls": ["https://console.example.test"],
            # The caller-only key that re-runs the invocation when the actor's code changes.
            "handler_version": "abc123=",
        }
    )

    assert result["changed"] == "true"
    assert [name for name, _ in client.calls] == [
        "describe_user_pool_client",
        "update_user_pool_client",
    ]


def test_the_terraform_invocation_and_the_handler_agree_on_the_action_name():
    """A typo either side is an apply that fails at its last resource, so pin the pair.

    The root's `input` is the only caller, and nothing between the two is typed.
    """
    root = (
        pathlib.Path(__file__).resolve().parents[2]
        / "infra"
        / "environments"
        / "recon"
        / "main.tf"
    ).read_text(encoding="utf-8")
    names = set(re.findall(r'action\s+=\s+"([a-z_]+)"', root))
    assert names, "no deploy-actions invocation found in the recon root"
    assert names <= set(hnd.ACTIONS), f"the root invokes actions the handler does not have: {sorted(names - set(hnd.ACTIONS))}"


# --- dispatch -------------------------------------------------------------------------------


def test_handle_rejects_an_unknown_action(patch_boto):
    """A typo in a Terraform `input` must fail the apply, not skip a load-bearing wait."""
    with pytest.raises(ValueError, match="unknown action"):
        hnd.handle({"action": "wait_for_godot"})


def test_handle_rejects_a_missing_action():
    with pytest.raises(ValueError, match="unknown action"):
        hnd.handle({})


def test_handle_ignores_caller_only_keys(patch_boto):
    """Callers add keys the handler must not choke on.

    `handler_version` exists purely to make the invocation's input change when the actor's code
    changes, and `corpus` is a content hash that forces re-ingestion. Neither is an action argument,
    so the actions accept and ignore them via **_ — if that broke, every apply would fail.
    """
    patch_boto(FakeClient([{"dataSource": {"status": "AVAILABLE"}}]))
    assert hnd.handle(
        {
            "action": "wait_kb_data_source",
            "knowledge_base_id": "kb",
            "data_source_id": "ds",
            "handler_version": "abc123=",
            "corpus": "deadbeef",
        }
    ) == {"status": "AVAILABLE"}


def test_handler_imports_nothing_outside_the_stdlib_and_boto3():
    """⚠️ The zip is built by archive_file with NO pip step, so a third-party import would fail at
    runtime — and adding a pip step here would reintroduce the plan-time tooling dependency this
    function exists to remove."""
    # Parsed rather than string-matched: a prose line in the module docstring that happens to begin
    # "import ..." reads as an import to a naive scan (it did, on the first version of this test).
    # Sibling modules shipped in the same zip are fine — they are part of the deployment artifact,
    # not a dependency to install. Derived from src/ rather than listed, so adding one does not
    # require editing this test (and removing one does not leave a stale exemption behind).
    local_modules = {path.stem for path in _SRC.parent.glob("*.py")}
    allowed = {"__future__", "time", "typing", "boto3"} | local_modules

    imports = set()
    for source in _SRC.parent.glob("*.py"):
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imports.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module.split(".")[0])
    # hashlib and re are stdlib, used by seed_push.
    allowed |= {"hashlib", "re", "io"}
    assert imports <= allowed, f"unexpected imports: {imports - allowed}"

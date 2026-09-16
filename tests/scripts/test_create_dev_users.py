"""Tests for scripts/create_dev_users.py — the five demonstration operators in the console's pool.

The boto3 client is a hand-written fake (`FakeCognito` below), not moto: the behaviours this script
exists to get right are "already there, do nothing", "created between the read and the write", and
"the account is gone" — each of which is a specific AWS error code on a specific call, and asserting
on them needs the fake to be able to RAISE those codes rather than to be faithful. It records calls
separately from state for the same reason `tests/infra/conftest.py`'s FakeS3 does: several of the
outcomes here are "make no call at all", and a version that re-created an existing account with the
same attributes would be invisible in the resulting state.

Nothing here talks to AWS, and nothing here creates a user pool.

What breaks in production if these fail: the script's whole contract is that a second run is safe and
that the five accounts land in the groups the pool actually created. A drifted group name is answered
by Cognito with ResourceNotFoundException naming a group — never naming this script — and a
non-idempotent run leaves an operator unable to re-run after a partial failure, which is exactly when
they need to.
"""

import re
from pathlib import Path

import pytest

from scripts.create_dev_users import (
    DEFAULT_GROUP_NAMES,
    DEV_USERS,
    MIN_PASSWORD_LENGTH,
    ROLES,
    delete_user,
    generate_password,
    main,
    parse_group_override,
    password_complaint,
    plan_user,
    prompt_password,
    resolve_deployment,
    run_create,
    run_delete,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_AUTH_VARIABLES = REPO_ROOT / "infra" / "modules" / "console-auth" / "variables.tf"

POOL_ID = "us-east-1_EXAMPLE1"
# The names the pool creates by default, as the script resolves them.
GROUPS = dict(DEFAULT_GROUP_NAMES)


def _client_error(code: str) -> Exception:
    """An exception shaped like botocore's ClientError, carrying an error code.

    :param code: the AWS error code to expose at ``response["Error"]["Code"]``.
    :returns: the exception instance, ready to raise.
    """
    exc = RuntimeError(code)
    exc.response = {"Error": {"Code": code}}
    return exc


class FakeCognito:
    """An in-memory `cognito-idp` stand-in covering the five calls this script makes."""

    def __init__(self, users: dict[str, list[str]] | None = None):
        """Start with the given accounts.

        :param users: username -> group names it already holds.
        """
        self.users: dict[str, list[str]] = {k: list(v) for k, v in (users or {}).items()}
        # Writes, recorded separately from state: "created nothing" is an outcome to assert.
        self.created: list[dict] = []
        self.added: list[tuple[str, str]] = []
        self.removed: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        # When set, admin_create_user raises this code once (the concurrent-creation race).
        self.create_raises: str | None = None

    def admin_get_user(self, *, UserPoolId, Username):  # noqa: N803 - boto3's parameter casing
        if Username not in self.users:
            raise _client_error("UserNotFoundException")
        return {"Username": Username}

    def admin_list_groups_for_user(self, *, UserPoolId, Username, **_kw):  # noqa: N803
        return {"Groups": [{"GroupName": g} for g in self.users[Username]]}

    def admin_create_user(self, **kw):
        if self.create_raises:
            code, self.create_raises = self.create_raises, None
            raise _client_error(code)
        self.created.append(kw)
        self.users.setdefault(kw["Username"], [])
        return {}

    def admin_add_user_to_group(self, *, UserPoolId, Username, GroupName):  # noqa: N803
        self.added.append((Username, GroupName))
        self.users.setdefault(Username, []).append(GroupName)
        return {}

    def admin_remove_user_from_group(self, *, UserPoolId, Username, GroupName):  # noqa: N803
        self.removed.append((Username, GroupName))
        self.users[Username] = [g for g in self.users[Username] if g != GroupName]
        return {}

    def admin_delete_user(self, *, UserPoolId, Username):  # noqa: N803
        if Username not in self.users:
            raise _client_error("UserNotFoundException")
        del self.users[Username]
        self.deleted.append(Username)
        return {}


def _by_email(email: str):
    """The DevUser with this address.

    :param email: the account address.
    :returns: the DevUser entry.
    """
    return next(u for u in DEV_USERS if u.email == email)


# --- the access model the five accounts demonstrate --------------------------------------------


def test_the_five_accounts_cover_every_state_the_console_can_put_a_viewer_in():
    """One recon-only, one pipeline-only, one admin of both, one console admin, one in no group.

    If a state loses its account the model stops being demonstrable in a browser, which is the whole
    reason this script exists rather than a line in the README telling an operator to run
    admin-create-user five times.
    """
    by_roles = {user.email: set(user.roles) for user in DEV_USERS}
    assert by_roles == {
        "recon-analyst@example.com": {"recon-access"},
        "deal-desk-user@example.com": {"pipeline-access"},
        "both-apps-admin@example.com": {"recon-admin", "pipeline-admin"},
        "console-admin@example.com": {"console-admin"},
        "no-access@example.com": set(),
    }


def test_every_role_named_by_an_account_is_one_the_pool_creates():
    """A typo'd role key would resolve to a KeyError at plan time, or to no group at all."""
    for user in DEV_USERS:
        assert set(user.roles) <= set(ROLES), user.email


def test_every_address_is_in_the_reserved_example_domain():
    """RFC 2606's `example.com` cannot receive mail, which is what makes this script unable to
    email a real person and `--delete` unable to remove a real operator's account. A local part that
    looked like somebody's name would also be a name in a published sample.
    """
    for user in DEV_USERS:
        assert user.email.endswith("@example.com"), user.email
        local = user.email.split("@")[0]
        assert re.fullmatch(r"[a-z][a-z-]*[a-z]", local), local


def test_default_group_names_match_the_console_auth_module():
    """The fourth copy of the five group names must equal the module's declared defaults.

    This script hard-codes them so `--user-pool-id` works with no Terraform state to read. Drift is
    silent in the worst way: `admin_add_user_to_group` answers ResourceNotFoundException naming a
    GROUP, so an operator reads it as a broken pool rather than as a stale dict in a script.
    """
    text = CONSOLE_AUTH_VARIABLES.read_text()
    declared = {}
    for role, variable in (
        ("recon-access", "recon_access_group"),
        ("recon-admin", "recon_admin_group"),
        ("pipeline-access", "pipeline_access_group"),
        ("pipeline-admin", "pipeline_admin_group"),
        ("console-admin", "console_admin_group"),
    ):
        match = re.search(rf'variable "{variable}" \{{.*?default\s*=\s*"([^"]+)"', text, re.DOTALL)
        assert match, f"no default found for variable {variable} in {CONSOLE_AUTH_VARIABLES}"
        declared[role] = match.group(1)
    assert DEFAULT_GROUP_NAMES == declared


# --- resolving the deployment -------------------------------------------------------------------


def _outputs(pool_id: str = POOL_ID, groups: dict[str, str] | None = None) -> dict:
    """`terraform output -json` shaped as terraform renders it.

    :param pool_id: value of the cognito_user_pool_id output.
    :param groups: value of the cognito_group_names output, or None to omit it.
    :returns: the output map.
    """
    outputs = {"cognito_user_pool_id": {"value": pool_id, "sensitive": False}}
    if groups is not None:
        outputs["cognito_group_names"] = {"value": groups, "sensitive": False}
    return outputs


def test_pool_and_group_names_come_from_the_terraform_output():
    """The zero-argument case: a deployment that renamed a group is followed without being told."""
    renamed = dict(GROUPS, **{"recon-access": "recon-readers"})
    pool, groups = resolve_deployment(
        outputs=_outputs(groups=renamed), user_pool_id=None, group_overrides={}
    )
    assert pool == POOL_ID
    assert groups["recon-access"] == "recon-readers"


def test_an_explicit_pool_id_and_group_override_win_over_the_output():
    """Most explicit wins, so a second pool can be seeded without editing Terraform state."""
    pool, groups = resolve_deployment(
        outputs=_outputs(groups=GROUPS),
        user_pool_id="us-east-1_OTHER",
        group_overrides={"pipeline-admin": "desk-leads"},
    )
    assert pool == "us-east-1_OTHER"
    assert groups["pipeline-admin"] == "desk-leads"
    # Everything not overridden still comes from the output.
    assert groups["recon-access"] == GROUPS["recon-access"]


def test_group_names_fall_back_to_the_module_defaults_when_the_output_has_none():
    """`--user-pool-id` with no Terraform state must still produce five real group names."""
    _, groups = resolve_deployment(outputs={}, user_pool_id=POOL_ID, group_overrides={})
    assert groups == GROUPS


def test_an_empty_pool_output_is_reported_as_an_okta_or_entra_deployment():
    """The message must name the CAUSE. An empty output is not a missing one: it means
    auth_provider is okta or entra, so there is no pool and never will be one until that changes.
    Reporting "no pool found" would send the operator looking for a broken output instead.
    """
    with pytest.raises(ValueError) as excinfo:
        resolve_deployment(outputs=_outputs(pool_id=""), user_pool_id=None, group_overrides={})
    message = str(excinfo.value)
    assert "auth_provider" in message
    assert "cognito" in message


def test_a_missing_pool_output_names_both_ways_to_supply_one():
    with pytest.raises(ValueError, match="--user-pool-id"):
        resolve_deployment(outputs={}, user_pool_id=None, group_overrides={})


def test_an_unknown_role_in_a_group_override_is_refused_by_name():
    """`--group recon_access=...` (underscores) is the likely typo, and silently ignoring it would
    put users in the default group while the operator believed they had renamed it.
    """
    with pytest.raises(ValueError, match="recon_access"):
        resolve_deployment(
            outputs=_outputs(), user_pool_id=None, group_overrides={"recon_access": "x"}
        )


def test_a_blank_resolved_group_name_is_refused():
    """A blank name would create nothing and add nobody; Cognito's own error names a field."""
    with pytest.raises(ValueError, match="console-admin"):
        resolve_deployment(
            outputs=_outputs(groups=dict(GROUPS, **{"console-admin": "  "})),
            user_pool_id=None,
            group_overrides={},
        )


def test_group_override_parsing_requires_both_halves():
    assert parse_group_override(" recon-access = recon-readers ") == (
        "recon-access",
        "recon-readers",
    )
    with pytest.raises(Exception, match="role.*=.*group-name"):
        parse_group_override("recon-access")
    with pytest.raises(Exception):
        parse_group_override("=recon-readers")


# --- the plan: what a first run does, and what a second run does not ---------------------------


def test_a_missing_account_is_planned_as_a_creation_with_every_wanted_group():
    plan = plan_user(
        user=_by_email("both-apps-admin@example.com"),
        groups=GROUPS,
        exists=False,
        current_groups=[],
        prune=False,
    )
    assert plan.create is True
    assert plan.add_groups == ["recon-admins", "deal-desk-admins"]
    assert plan.remove_groups == []
    assert plan.is_noop is False


def test_add_groups_is_ordered_by_role_so_two_reports_read_the_same():
    """The report is the product. An order that came out of a set would make two identical runs look
    like two different ones.
    """
    plan = plan_user(
        user=_by_email("both-apps-admin@example.com"),
        groups=GROUPS,
        exists=False,
        current_groups=[],
        prune=False,
    )
    assert plan.add_groups == [GROUPS["recon-admin"], GROUPS["pipeline-admin"]]


def test_an_account_already_in_its_groups_yields_an_empty_plan():
    """The idempotency, decided from the pool's answer rather than from a marker."""
    plan = plan_user(
        user=_by_email("recon-analyst@example.com"),
        groups=GROUPS,
        exists=True,
        current_groups=["recon-users"],
        prune=False,
    )
    assert plan.is_noop is True
    assert (plan.create, plan.add_groups, plan.remove_groups) == (False, [], [])


def test_the_no_group_account_is_a_noop_once_it_exists():
    """Its whole point is holding no group, so nothing about it may look like work to do."""
    plan = plan_user(
        user=_by_email("no-access@example.com"),
        groups=GROUPS,
        exists=True,
        current_groups=[],
        prune=False,
    )
    assert plan.is_noop is True


def test_a_partially_created_account_is_completed_rather_than_recreated():
    """The state a failed first run leaves: the account exists, one of its two groups landed."""
    plan = plan_user(
        user=_by_email("both-apps-admin@example.com"),
        groups=GROUPS,
        exists=True,
        current_groups=["recon-admins"],
        prune=False,
    )
    assert plan.create is False
    assert plan.add_groups == ["deal-desk-admins"]


def test_an_extra_group_is_left_alone_by_default_and_removed_under_prune():
    """A group added by hand — an operator's own, or one a federated provider mapped — is not this
    script's to revoke unless it is asked to own the membership.
    """
    user = _by_email("recon-analyst@example.com")
    kept = plan_user(
        user=user,
        groups=GROUPS,
        exists=True,
        current_groups=["recon-users", "console-admins"],
        prune=False,
    )
    assert kept.remove_groups == []
    assert kept.is_noop is True

    pruned = plan_user(
        user=user,
        groups=GROUPS,
        exists=True,
        current_groups=["recon-users", "console-admins"],
        prune=True,
    )
    assert pruned.remove_groups == ["console-admins"]
    assert pruned.is_noop is False


def test_prune_plans_no_removal_for_an_account_that_does_not_exist_yet():
    """There is nothing to revoke, and a removal call on a missing user is an error."""
    plan = plan_user(
        user=_by_email("recon-analyst@example.com"),
        groups=GROUPS,
        exists=False,
        current_groups=[],
        prune=True,
    )
    assert plan.remove_groups == []


# --- applying it -------------------------------------------------------------------------------


def test_a_first_run_creates_five_accounts_with_suppressed_invites_and_verified_email():
    """SUPPRESS because example.com cannot receive mail and Cognito's sender is capped at 50/day;
    email_verified because an unverified address cannot use the forgot-password flow, and there is no
    delivery through which it could ever be verified.
    """
    client = FakeCognito()
    counts = run_create(
        client=client,
        user_pool_id=POOL_ID,
        groups=GROUPS,
        temporary_password="Aa1!Aa1!Aa1!",
        dry_run=False,
        prune=False,
    )
    assert counts == {"created": 5, "updated": 0, "unchanged": 0}
    assert [call["Username"] for call in client.created] == [u.email for u in DEV_USERS]
    for call in client.created:
        assert call["MessageAction"] == "SUPPRESS"
        assert {"Name": "email_verified", "Value": "true"} in call["UserAttributes"]
        assert call["TemporaryPassword"] == "Aa1!Aa1!Aa1!"
    # Four accounts hold groups; the fifth deliberately holds none.
    assert sorted(client.added) == sorted(
        [
            ("recon-analyst@example.com", "recon-users"),
            ("deal-desk-user@example.com", "deal-desk"),
            ("both-apps-admin@example.com", "recon-admins"),
            ("both-apps-admin@example.com", "deal-desk-admins"),
            ("console-admin@example.com", "console-admins"),
        ]
    )
    assert client.users["no-access@example.com"] == []


def test_a_second_run_writes_nothing_at_all():
    """Re-running is the documented recovery from a partial failure, so it has to be free."""
    client = FakeCognito()
    run_create(
        client=client,
        user_pool_id=POOL_ID,
        groups=GROUPS,
        temporary_password="Aa1!Aa1!Aa1!",
        dry_run=False,
        prune=False,
    )
    client.created.clear()
    client.added.clear()

    counts = run_create(
        client=client,
        user_pool_id=POOL_ID,
        groups=GROUPS,
        temporary_password="Bb2?Bb2?Bb2?",
        dry_run=False,
        prune=False,
    )
    assert counts == {"created": 0, "updated": 0, "unchanged": 5}
    assert client.created == []
    assert client.added == []
    assert client.removed == []


def test_a_dry_run_reads_the_pool_and_writes_nothing():
    client = FakeCognito()
    counts = run_create(
        client=client,
        user_pool_id=POOL_ID,
        groups=GROUPS,
        temporary_password="",
        dry_run=True,
        prune=False,
    )
    assert counts == {"created": 5, "updated": 0, "unchanged": 0}
    assert (client.created, client.added, client.removed) == ([], [], [])


def test_an_account_created_between_the_read_and_the_write_does_not_abort_the_run():
    """UsernameExistsException is swallowed and the group reconciliation still runs. Two round trips
    cannot be atomic, and a script whose contract is "safe to re-run" must not fail on the one race
    that re-running produces.
    """
    client = FakeCognito()
    client.create_raises = "UsernameExistsException"
    run_create(
        client=client,
        user_pool_id=POOL_ID,
        groups=GROUPS,
        temporary_password="Aa1!Aa1!Aa1!",
        dry_run=False,
        prune=False,
    )
    # The first account's creation was refused, and it still ended up in its group.
    assert ("recon-analyst@example.com", "recon-users") in client.added
    assert len(client.created) == 4


def test_any_other_create_error_propagates():
    """A partial run that reports success is worse than a crash: the operator signs in as the one
    account that landed and concludes authorization is broken.
    """
    client = FakeCognito()
    client.create_raises = "InvalidPasswordException"
    with pytest.raises(RuntimeError, match="InvalidPasswordException"):
        run_create(
            client=client,
            user_pool_id=POOL_ID,
            groups=GROUPS,
            temporary_password="short",
            dry_run=False,
            prune=False,
        )


def test_group_membership_is_paginated():
    """A user in more groups than one page returns would otherwise look like a user missing groups,
    and the script would re-add memberships it already has on every run.
    """

    class Paged(FakeCognito):
        def admin_list_groups_for_user(self, *, UserPoolId, Username, **kw):  # noqa: N803
            if not kw.get("NextToken"):
                return {"Groups": [{"GroupName": "recon-admins"}], "NextToken": "t"}
            return {"Groups": [{"GroupName": "deal-desk-admins"}]}

    client = Paged({"both-apps-admin@example.com": []})
    run_create(
        client=client,
        user_pool_id=POOL_ID,
        groups=GROUPS,
        temporary_password="Aa1!Aa1!Aa1!",
        dry_run=False,
        prune=False,
    )
    assert ("both-apps-admin@example.com", "recon-admins") not in client.added
    assert ("both-apps-admin@example.com", "deal-desk-admins") not in client.added


# --- delete ------------------------------------------------------------------------------------


def test_delete_removes_the_five_accounts_and_never_a_group():
    """The groups are Terraform's (infra/modules/console-auth). Deleting one here would leave the
    next plan recreating a group whose membership had been silently emptied.
    """
    client = FakeCognito({u.email: [] for u in DEV_USERS})
    counts = run_delete(client=client, user_pool_id=POOL_ID, dry_run=False)
    assert counts == {"deleted": 5, "absent": 0}
    assert sorted(client.deleted) == sorted(u.email for u in DEV_USERS)
    assert client.removed == []


def test_delete_is_idempotent_and_reports_what_was_already_gone():
    client = FakeCognito({"recon-analyst@example.com": ["recon-users"]})
    counts = run_delete(client=client, user_pool_id=POOL_ID, dry_run=False)
    assert counts == {"deleted": 1, "absent": 4}
    assert run_delete(client=client, user_pool_id=POOL_ID, dry_run=False) == {
        "deleted": 0,
        "absent": 5,
    }


def test_delete_dry_run_deletes_nothing():
    client = FakeCognito({u.email: [] for u in DEV_USERS})
    counts = run_delete(client=client, user_pool_id=POOL_ID, dry_run=True)
    assert counts == {"deleted": 5, "absent": 0}
    assert client.deleted == []


def test_delete_user_reports_absence_rather_than_raising():
    client = FakeCognito()
    assert delete_user(client=client, user_pool_id=POOL_ID, email="no-access@example.com") is False


# --- the temporary password --------------------------------------------------------------------


def test_no_password_is_committed_anywhere_in_the_script():
    """The one rule that matters most here. A default, a constant or an example that happened to
    satisfy the policy would be a working credential in a public sample.
    """
    source = (REPO_ROOT / "scripts" / "create_dev_users.py").read_text()
    assert "TemporaryPassword=temporary_password" in source
    # No assignment of a policy-satisfying literal to anything password-shaped.
    for match in re.finditer(r"(?i)pass(word)?\w*\s*=\s*\"([^\"]+)\"", source):
        assert password_complaint(match.group(2)) is not None, match.group(0)


def test_a_password_that_fails_the_pools_policy_is_refused_locally_with_the_rule():
    assert "12" in (password_complaint("Short1!") or "")
    assert "uppercase" in (password_complaint("lowercase-only-1!") or "")
    assert "digit" in (password_complaint("NoDigitsHere!!") or "")
    assert "symbol" in (password_complaint("NoSymbolsHere1") or "")
    assert password_complaint("Aa1!Aa1!Aa1!") is None


def test_a_generated_password_always_satisfies_the_policy():
    """Built class by class rather than drawn at random, so it cannot fail by chance — a failure
    would arrive as InvalidPasswordException part-way through creating five accounts.
    """
    for _ in range(200):
        password = generate_password()
        assert len(password) >= MIN_PASSWORD_LENGTH
        assert password_complaint(password) is None
    assert generate_password() != generate_password()


def test_a_short_length_request_is_raised_to_the_policy_minimum():
    assert len(generate_password(length=4)) == MIN_PASSWORD_LENGTH


def test_the_prompt_asks_twice_and_refuses_a_mismatch():
    answers = iter(["Aa1!Aa1!Aa1!", "Bb2?Bb2?Bb2?"])
    with pytest.raises(ValueError, match="did not match"):
        prompt_password(prompt=lambda _: next(answers))


def test_the_prompt_refuses_a_weak_password_before_the_second_entry():
    """Naming the rule on the first entry, so the operator is not asked to repeat a password that
    was never going to be accepted.
    """
    calls = []

    def prompt(text):
        calls.append(text)
        return "weak"

    with pytest.raises(ValueError, match="at least 12"):
        prompt_password(prompt=prompt)
    assert len(calls) == 1


def test_the_prompt_returns_the_confirmed_password():
    assert prompt_password(prompt=lambda _: "Aa1!Aa1!Aa1!") == "Aa1!Aa1!Aa1!"


# --- argument handling -------------------------------------------------------------------------


def test_dry_run_with_no_arguments_reads_terraform_and_never_prompts(monkeypatch, capsys):
    """The first thing an operator runs. It must not ask for a password it will not use, and it must
    resolve the deployment on its own.
    """
    client = FakeCognito()
    monkeypatch.setattr(
        "scripts.create_dev_users.terraform_outputs", lambda **_kw: _outputs(groups=GROUPS)
    )
    monkeypatch.setattr(
        "scripts.create_dev_users.boto3.Session", lambda **_kw: _FakeSession(client)
    )
    monkeypatch.setattr(
        "scripts.create_dev_users.prompt_password",
        lambda **_kw: pytest.fail("--dry-run must not prompt for a password"),
    )
    assert main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert POOL_ID in out
    assert "nothing was created" in out
    assert (client.created, client.added) == ([], [])


def test_a_terraform_failure_is_fatal_when_no_pool_was_named(monkeypatch, capsys):
    """The operator gets terraform's own message. An uninitialised root and an Okta deployment look
    identical otherwise.
    """

    def boom(**_kw):
        raise RuntimeError("terraform init has not been run")

    monkeypatch.setattr("scripts.create_dev_users.terraform_outputs", boom)
    assert main(["--dry-run"]) == 2
    assert "terraform init has not been run" in capsys.readouterr().err


def test_a_terraform_failure_is_survivable_when_a_pool_was_named(monkeypatch, capsys):
    """`--user-pool-id` in a clone with no state must still work: the outputs were wanted only for
    the group names, and the module defaults cover those.
    """
    client = FakeCognito()

    def boom(**_kw):
        raise RuntimeError("no state")

    monkeypatch.setattr("scripts.create_dev_users.terraform_outputs", boom)
    monkeypatch.setattr(
        "scripts.create_dev_users.boto3.Session", lambda **_kw: _FakeSession(client)
    )
    assert main(["--dry-run", "--user-pool-id", POOL_ID]) == 0
    captured = capsys.readouterr()
    assert "default group names" in captured.err
    assert POOL_ID in captured.out


def test_every_group_named_on_the_command_line_skips_terraform_entirely(monkeypatch):
    """A pool id plus all five group names is a complete answer, so a clone with no Terraform state
    (and no terraform binary) can still seed a pool.
    """
    client = FakeCognito()
    monkeypatch.setattr(
        "scripts.create_dev_users.terraform_outputs",
        lambda **_kw: pytest.fail("terraform must not be consulted when every value was given"),
    )
    monkeypatch.setattr(
        "scripts.create_dev_users.boto3.Session", lambda **_kw: _FakeSession(client)
    )
    argv = ["--dry-run", "--user-pool-id", POOL_ID]
    for role, name in DEFAULT_GROUP_NAMES.items():
        argv += ["--group", f"{role}={name}"]
    assert main(argv) == 0


def test_generate_password_prints_the_password_once_and_writes_no_file(
    monkeypatch, capsys, tmp_path
):
    """The printed value is the ONLY copy. A file would be the copy that outlives the demo."""
    client = FakeCognito()
    monkeypatch.setattr(
        "scripts.create_dev_users.terraform_outputs", lambda **_kw: _outputs(groups=GROUPS)
    )
    monkeypatch.setattr(
        "scripts.create_dev_users.boto3.Session", lambda **_kw: _FakeSession(client)
    )
    monkeypatch.chdir(tmp_path)
    assert main(["--generate-password"]) == 0
    out = capsys.readouterr().out
    printed = client.created[0]["TemporaryPassword"]
    assert password_complaint(printed) is None
    assert out.count(printed) == 1
    assert list(tmp_path.iterdir()) == []


def test_delete_mode_says_it_touched_no_group(monkeypatch, capsys):
    """An operator cleaning up needs to know the pool is back to the shape Terraform expects."""
    client = FakeCognito({u.email: [] for u in DEV_USERS})
    monkeypatch.setattr(
        "scripts.create_dev_users.terraform_outputs", lambda **_kw: _outputs(groups=GROUPS)
    )
    monkeypatch.setattr(
        "scripts.create_dev_users.boto3.Session", lambda **_kw: _FakeSession(client)
    )
    assert main(["--delete"]) == 0
    out = capsys.readouterr().out
    assert "deleted=5 absent=0" in out
    assert "no group was touched" in out


def test_an_okta_deployment_exits_two_without_calling_cognito(monkeypatch, capsys):
    client = FakeCognito()
    monkeypatch.setattr(
        "scripts.create_dev_users.terraform_outputs", lambda **_kw: _outputs(pool_id="")
    )
    monkeypatch.setattr(
        "scripts.create_dev_users.boto3.Session",
        lambda **_kw: pytest.fail("no AWS client should be built for an Okta deployment"),
    )
    assert main(["--dry-run"]) == 2
    assert "auth_provider" in capsys.readouterr().err
    assert client.created == []


class _FakeSession:
    """A boto3.Session stand-in handing out one prepared client."""

    def __init__(self, client):
        """Store the client every `client()` call returns.

        :param client: the FakeCognito instance.
        """
        self._client = client

    def client(self, _name):
        return self._client

"""Push repo edits to the UI-editable S3 seed objects, unless the live object was edited.

The prompt and skill objects in the assets bucket are seeded by `aws_s3_object` resources carrying
`lifecycle { ignore_changes = [etag, source] }`, because the UI prompt editor and the BFF skills
manager rewrite them in place and an apply must never clobber an analyst's edit. That rule on its own
has a silent consequence: a repo edit to a prompt or a skill never reaches S3 through `terraform
apply`, so the apply is green while the deployed agent keeps running the previously seeded
instructions.

This closes the gap without weakening the lifecycle rule. Per seed it compares three fingerprints:

    REPO_MD5   the MD5 of the repo file's content
    LIVE_ETAG  the live object's ETag
    MARKER     `.seed-marker/<key>.md5`, the MD5 this code last pushed

and takes exactly one of four outcomes: no-op, adopt, push, or fail. A UI edit alone is
NOT a conflict — if the repo file has not changed, the analyst's edit is the only change and it wins.
It fails only when BOTH sides moved, which no rule can resolve without a human.

**The ETag is only an MD5 for single-part objects in an SSE-S3 bucket.** Under SSE-KMS, or for a
multipart upload, it is something else entirely, and comparing it would silently either clobber every
edit or never push anything. Both conditions are checked and are hard failures, because both silent
degradations are worse than stopping.

⚠️ WHY THIS LIVES HERE, NEXT TO THE LAMBDA HANDLER

It has two callers that must never disagree about the decision table:

  1. the deploy-actions Lambda (`handler.push_editable_seeds`), during `terraform apply`;
  2. `infra/scripts/push_editable_seeds.py`, run by hand by an operator resolving a conflict.

Both import this module, so there is one copy of the rules. Everything here is boto3, never a shell-out
to the AWS CLI: the Lambda runtime provides boto3 and the repo venv already has it, whereas the CLI
would make an apply depend on whatever happens to be installed on the machine running Terraform.

⚠️ CONTENT, NOT PATHS. The Lambda has no repo checkout, so callers pass the seed CONTENT and a
`source` label used only in operator-facing messages. The MD5 is always computed here from that
content, never accepted from the caller, so the two callers cannot fingerprint differently.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

MARKER_PREFIX = ".seed-marker/"
# The `.md5` suffix keeps a marker from ever looking like content: without it, the marker for
# `skills/unknown/SKILL.md` would itself end in `.md`, and `read_s3_skills`
# (backend/recon_core/skill_meta.py) parses ANY listed key ending in `.md` as a skill. Only the
# `skills/` prefix keeps markers out of that listing today; the suffix makes it impossible instead.
MARKER_SUFFIX = ".md5"
# The `decide` outcomes that need a human. Listed explicitly rather than inferred (e.g. from casing),
# so adding an outcome forces a deliberate choice about which side of the gate it falls on.
FAILURES = frozenset({"AMBIGUOUS", "CONFLICT"})
# S3 reports a single-part ETag as 32 hex characters. A multipart ETag carries a `-<partcount>`
# suffix and is a digest OF DIGESTS, not of the content.
_SINGLE_PART_ETAG = re.compile(r"^[0-9a-f]{32}$")

SEED_CONTENT_TYPE = "text/markdown"


class SeedPushError(RuntimeError):
    """A seed reconciliation that must stop the apply.

    A distinct type rather than SystemExit: this runs inside a Lambda, where SystemExit is not a
    meaningful way to report failure, and the message has to reach the invoker intact so it lands in
    the apply's error output.
    """


def content_md5(content: str) -> str:
    """MD5 hex digest of a seed's content as it will be stored.

    Encoded UTF-8 so the digest matches both Terraform's ``filemd5`` of the repo file and the ETag
    S3 computes for the object this code uploads.

    :param content: the seed body.
    :returns: 32-character lowercase hex digest.
    """
    return hashlib.md5(content.encode("utf-8")).hexdigest()  # noqa: S324 - matches the S3 ETag, not security


def assert_etag_is_md5(*, s3: Any, bucket: str) -> None:
    """Fail unless the bucket's default encryption makes the ETag an MD5 of the content.

    SSE-S3 (`AES256`) leaves the ETag as the content MD5; SSE-KMS and SSE-C do not. Every comparison
    below assumes the former, so a different algorithm invalidates the whole approach and must stop
    the apply rather than produce confident nonsense.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :raises SeedPushError: when encryption is absent or is not `AES256`.
    """
    # ⚠️ Only ONE failure means "no default encryption": the API's own not-found code. Everything
    # else — AccessDenied above all — must be re-raised with the real cause.
    #
    # A blanket `except Exception: algo = None` here reported an AccessDenied as
    # "default encryption is None, not 'AES256'", which sent the first live apply looking at bucket
    # configuration that was correct all along. The inherited CLI version had the same shape
    # (`returncode != 0 -> None`), but it ran under the deployer's admin credentials and so never hit
    # the case; a scoped Lambda role does.
    try:
        rules = s3.get_bucket_encryption(Bucket=bucket)["ServerSideEncryptionConfiguration"][
            "Rules"
        ]
        algo = rules[0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"]
    except Exception as exc:  # noqa: BLE001 - narrowed immediately below
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
        if code != "ServerSideEncryptionConfigurationNotFoundError":
            raise SeedPushError(
                f"could not read the default encryption of bucket {bucket}: {code or exc!r}.\n"
                "  This is NOT the same as the bucket having no default encryption — the ETag-is-an-MD5\n"
                "  invariant could not be checked either way, so nothing was compared or written."
            ) from exc
        algo = None
    if algo != "AES256":
        raise SeedPushError(
            f"bucket {bucket} default encryption is {algo!r}, not 'AES256'.\n"
            "  This reconciliation compares an object's ETag against a content MD5, which is only "
            "valid for SSE-S3.\n"
            "  Refusing to compare fingerprints that do not mean what they are assumed to mean."
        )


def live_etag(*, s3: Any, bucket: str, key: str) -> str | None:
    """The live object's ETag, or None when the object does not exist.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :param key: the object key.
    :returns: the ETag with quotes stripped, or None if absent.
    :raises SeedPushError: when the ETag is not a single-part digest, so is not an MD5.
    """
    try:
        etag = s3.head_object(Bucket=bucket, Key=key)["ETag"].strip('"')
    except Exception:  # noqa: BLE001 - a missing object is an expected outcome, not a failure
        return None
    if not _SINGLE_PART_ETAG.match(etag):
        raise SeedPushError(
            f"{key} has a multipart ETag ({etag!r}), which is a digest of digests, not the "
            "content MD5.\n"
            "  Re-upload it as a single part (`aws s3 cp` does this for small files) and re-apply."
        )
    return etag


def read_marker(*, s3: Any, bucket: str, key: str) -> str | None:
    """The MD5 last pushed for `key`, or None if it has never been pushed.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :param key: the SEED object key (the marker prefix is added here).
    :returns: the recorded MD5, or None when no marker exists.
    """
    try:
        body = s3.get_object(Bucket=bucket, Key=f"{MARKER_PREFIX}{key}{MARKER_SUFFIX}")["Body"]
    except Exception:  # noqa: BLE001 - absence is the common case on a first run
        return None
    return body.read().decode("utf-8").strip() or None


def write_marker(*, s3: Any, bucket: str, key: str, digest: str) -> None:
    """Record `digest` as the content last pushed for `key`.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :param key: the SEED object key (the marker prefix is added here).
    :param digest: the MD5 hex to record.
    :raises SeedPushError: when the write fails — an unrecorded push would be re-read as a UI edit
        on the next run, turning a successful push into a spurious CONFLICT.
    """
    try:
        s3.put_object(
            Bucket=bucket,
            Key=f"{MARKER_PREFIX}{key}{MARKER_SUFFIX}",
            Body=digest.encode("utf-8"),
        )
    except Exception as exc:  # noqa: BLE001
        raise SeedPushError(
            f"failed to write the seed marker for {key}; refusing to continue."
        ) from exc


def _remedy(*, bucket: str, key: str, source: str) -> str:
    """The two commands that resolve a stuck key, so a failure is actionable.

    :param bucket: the assets bucket.
    :param key: the object key.
    :param source: the repo file that seeds it.
    :returns: an indented two-line remedy block.
    """
    # Neither remedy touches the marker, deliberately: both end with live == repo, so the next apply
    # takes the CONVERGED branch and refreshes the marker itself. A remedy an operator has to get
    # right in two places is a remedy that will be got wrong.
    return (
        "  Resolve by choosing one, then re-apply:\n"
        f"    take repo -> aws s3 cp {source} s3://{bucket}/{key} --content-type text/markdown\n"
        f"    keep live -> aws s3 cp s3://{bucket}/{key} {source}   # then commit the change"
    )


def push(*, s3: Any, bucket: str, key: str, content: str) -> None:
    """Upload the repo content over the live object.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :param key: the object key.
    :param content: the seed body to upload.
    :raises SeedPushError: when the upload fails.
    """
    try:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=content.encode("utf-8"),
            ContentType=SEED_CONTENT_TYPE,
        )
    except Exception as exc:  # noqa: BLE001
        raise SeedPushError(f"failed to push content to s3://{bucket}/{key}.") from exc


def decide(*, s3: Any, bucket: str, key: str, content: str, source: str) -> tuple[str, str]:
    """Classify one seed against the four-outcome decision table above, WITHOUT writing anything.

    Read-only on purpose. Deciding every key before acting on any is what makes a failing run leave
    the bucket completely untouched — otherwise an earlier key could be pushed and the aggregated
    error would claim "nothing was overwritten" while a push had already landed.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :param key: the object key.
    :param content: the repo content for this seed.
    :param source: repo path, used only in operator-facing messages.
    :returns: ``(action, detail)`` where action is one of ``record``, ``adopt``, ``re-adopt``,
        ``keep-live``, ``push``, ``noop``, ``AMBIGUOUS``, ``CONFLICT``. For the first six, detail is
        the repo MD5; for the last two it is the operator-facing failure block.
    """
    repo_md5 = content_md5(content)
    etag = live_etag(s3=s3, bucket=bucket, key=key)

    # The aws_s3_object resource has just created it from this same content: the object is already
    # correct, only the marker is missing.
    if etag is None:
        return "record", repo_md5

    marker = read_marker(s3=s3, bucket=bucket, key=key)

    if marker is None:
        if etag == repo_md5:
            return "adopt", repo_md5
        return "AMBIGUOUS", (
            f"AMBIGUOUS: {key}\n"
            f"  repo  {repo_md5}  {source}\n"
            f"  live  {etag}  (differs, and this key has never been pushed)\n"
            "  A UI edit and an object left stale by the create-only era look identical here.\n"
            + _remedy(bucket=bucket, key=key, source=source)
        )

    if etag != marker:
        # Live and repo already agree; only the marker is stale. This is what BOTH remedies in
        # `_remedy` produce, and it is NOT a conflict — there is nothing left to tell apart, so the
        # marker is not evidence of anything and is simply refreshed. Without this branch the two
        # tests below both fire and the key reports CONFLICT forever, with no way out.
        if etag == repo_md5:
            return "re-adopt", repo_md5
        # The repo has not moved since the last push, so the edit is the only change: it wins.
        if repo_md5 == marker:
            return "keep-live", repo_md5
        return "CONFLICT", (
            f"CONFLICT: {key}\n"
            f"  repo  {repo_md5}  {source}\n"
            f"  live  {etag}  (edited in the environment since the last seed push)\n"
            + _remedy(bucket=bucket, key=key, source=source)
        )

    return ("push", repo_md5) if repo_md5 != marker else ("noop", repo_md5)


def apply_action(
    *, s3: Any, action: str, bucket: str, key: str, content: str, repo_md5: str
) -> str:
    """Carry out one decision from `decide` and return a one-line description of what happened.

    :param s3: boto3 S3 client.
    :param action: the action `decide` returned.
    :param bucket: the assets bucket.
    :param key: the object key.
    :param content: the repo content for this seed.
    :param repo_md5: the content's MD5.
    :returns: a human-readable log line.
    :raises SeedPushError: on an unknown action — an unhandled branch must not pass silently.
    """
    if action == "noop":
        return f"unchanged {key}"
    if action == "keep-live":
        return f"live edit preserved (repo unchanged) {key}"
    if action == "push":
        push(s3=s3, bucket=bucket, key=key, content=content)
        write_marker(s3=s3, bucket=bucket, key=key, digest=repo_md5)
        return f"pushed {key}"
    if action in ("record", "adopt", "re-adopt"):
        write_marker(s3=s3, bucket=bucket, key=key, digest=repo_md5)
        wording = {
            "record": "recorded (new object)",
            "adopt": "adopted (already in sync)",
            "re-adopt": "re-adopted (converged out-of-band)",
        }[action]
        return f"{wording} {key}"
    raise SeedPushError(f"unhandled action {action!r} for {key}; refusing to guess.")


def reconcile(*, s3: Any, bucket: str, seeds: dict[str, dict]) -> dict[str, str]:
    """Decide every seed, then act only if none of them needs a human.

    ⚠️ Two phases, and the order is the safety property. Deciding everything first means a run that
    hits a conflict writes NOTHING — for the conflicting key or any other. A single-pass loop would
    push the keys it reached before the conflict and then report a failure that reads as if nothing
    had changed.

    :param s3: boto3 S3 client.
    :param bucket: the assets bucket.
    :param seeds: ``{key: {"content": str, "source": str}}``.
    :returns: ``{key: <what happened>}`` for every seed.
    :raises SeedPushError: when any key needs a human decision; the message names every such key.
    """
    assert_etag_is_md5(s3=s3, bucket=bucket)

    decisions = []
    for key in sorted(seeds):
        seed = seeds[key]
        action, detail = decide(
            s3=s3, bucket=bucket, key=key, content=seed["content"], source=seed["source"]
        )
        decisions.append((key, seed, action, detail))

    problems = [detail for _, _, action, detail in decisions if action in FAILURES]
    if problems:
        raise SeedPushError(
            "\n\n".join(problems) + f"\n\n{len(problems)} seed object(s) need a decision. "
            "Nothing was written — not for these keys and not for any other."
        )

    results = {}
    for key, seed, action, repo_md5 in decisions:
        results[key] = apply_action(
            s3=s3,
            action=action,
            bucket=bucket,
            key=key,
            content=seed["content"],
            repo_md5=repo_md5,
        )
    return results

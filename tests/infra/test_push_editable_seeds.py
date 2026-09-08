"""Every branch of the seed-push decision table.

The reconciliation decides, per seed, between four outcomes: no-op, push, adopt, and fail. Getting one
branch wrong is either destructive (overwriting an analyst's edit) or a silent regression (never
pushing), so each branch gets its own test naming which one it is.

The rules live in ``infra/modules/deploy-actions/src/seed_push.py`` and have two callers — the
deploy-actions Lambda during an apply, and ``infra/scripts/push_editable_seeds.py`` run by hand — so
these tests exercise the shared module directly rather than either entry point.
"""

import hashlib

import pytest
import seed_push


def md5(text: str) -> str:
    """MD5 hex of a string, matching what S3 reports as the ETag of a single-part object.

    Computed here with hashlib rather than imported from seed_push, so the fingerprint assertions do
    not simply agree with the implementation they are checking.

    :param text: the content to digest.
    :returns: 32-character lowercase hex digest.
    """
    return hashlib.md5(text.encode()).hexdigest()


PROMPT = "system-prompt.md"
# Must match MARKER_PREFIX/MARKER_SUFFIX in seed_push. Spelled out rather than imported so a rename
# there fails these tests loudly instead of silently agreeing with itself.
PROMPT_MARKER = ".seed-marker/system-prompt.md.md5"

BUCKET = "assets"


def _marker(key: str) -> str:
    """The marker key for a seed key.

    :param key: the seed object key.
    :returns: the sidecar key the reconciliation reads and writes.
    """
    return f".seed-marker/{key}.md5"


def _seeds(**content: str) -> dict[str, dict]:
    """Build a `seeds` mapping from key -> repo content.

    :param content: keyword form is unusable for keys containing dots, so callers pass a dict via
        ``**{...}``; each value is the repo content for that key.
    :returns: the ``{key: {"content", "source"}}`` shape reconcile expects.
    """
    return {k: {"content": v, "source": f"repo/{k}"} for k, v in content.items()}


def _run(fake_s3, seeds):
    """Reconcile and return the per-key outcome map.

    :param fake_s3: the FakeS3 fixture.
    :param seeds: the seeds mapping.
    :returns: reconcile's result dict.
    """
    return seed_push.reconcile(s3=fake_s3, bucket=BUCKET, seeds=seeds)


def test_a_missing_object_is_recorded_not_pushed(fake_s3) -> None:
    """`aws_s3_object` has just created it, so the content is already right — only the marker is due."""
    _run(fake_s3, _seeds(**{PROMPT: "hello"}))
    assert fake_s3.objects[PROMPT_MARKER]["body"] == md5("hello")
    # The object itself must not be rewritten: it already holds the repo's bytes.
    assert fake_s3.puts == [PROMPT_MARKER]


def test_an_in_sync_object_with_no_marker_is_adopted(fake_s3) -> None:
    """Bootstrap. Live == repo, so the mechanism can safely claim it without a human deciding."""
    fake_s3.put(PROMPT, "hello")
    _run(fake_s3, _seeds(**{PROMPT: "hello"}))
    assert fake_s3.objects[PROMPT_MARKER]["body"] == md5("hello")
    assert fake_s3.objects[PROMPT]["body"] == "hello"
    # Only the marker: adopting must not rewrite content that is already correct.
    assert fake_s3.puts == [PROMPT_MARKER]


def test_a_diverged_object_with_no_marker_fails_ambiguously(fake_s3) -> None:
    """Live != repo and no marker: a UI edit and a stale create-only object are indistinguishable."""
    fake_s3.put(PROMPT, "old")
    with pytest.raises(seed_push.SeedPushError) as exc:
        _run(fake_s3, _seeds(**{PROMPT: "new"}))
    message = str(exc.value)
    assert "AMBIGUOUS" in message
    assert PROMPT in message
    # BOTH remedies must be present, or the operator is stuck with a diagnosis and no cure.
    assert "take repo" in message and "keep live" in message
    assert fake_s3.puts == []


def test_an_unchanged_repo_file_writes_absolutely_nothing(fake_s3) -> None:
    """The common case: most applies touch no prompt at all, so a quiet apply must be a silent one."""
    fake_s3.put(PROMPT, "hello")
    fake_s3.put(PROMPT_MARKER, md5("hello"))
    _run(fake_s3, _seeds(**{PROMPT: "hello"}))
    assert fake_s3.objects[PROMPT]["body"] == "hello"
    # Asserted on `puts`, not on content: re-putting identical bytes is invisible in `objects`.
    assert fake_s3.puts == []


def test_a_changed_repo_file_is_pushed_and_the_marker_advances(fake_s3) -> None:
    """The defect this whole mechanism exists to fix: a repo edit must reach S3 through an apply."""
    fake_s3.put(PROMPT, "old")
    fake_s3.put(PROMPT_MARKER, md5("old"))
    _run(fake_s3, _seeds(**{PROMPT: "new"}))
    assert fake_s3.objects[PROMPT]["body"] == "new"
    assert fake_s3.objects[PROMPT_MARKER]["body"] == md5("new")


def test_a_ui_edit_survives_when_the_repo_did_not_change(fake_s3) -> None:
    """The destructive branch if got wrong. An analyst's edit wins; this is NOT a conflict."""
    fake_s3.put(PROMPT, "analyst edit")
    fake_s3.put(PROMPT_MARKER, md5("repo"))
    _run(fake_s3, _seeds(**{PROMPT: "repo"}))
    assert fake_s3.objects[PROMPT]["body"] == "analyst edit"
    # And nothing may be written at all: the marker still describes the last push.
    assert fake_s3.puts == []
    assert fake_s3.objects[PROMPT_MARKER]["body"] == md5("repo")


def test_a_stale_marker_over_agreeing_sides_is_re_adopted_not_a_conflict(fake_s3) -> None:
    """The state BOTH printed remedies produce. Without this branch the key conflicts forever.

    An operator resolves a conflict by copying one side over the other. Either way they end with
    live == repo and a marker describing neither. Two of the three exits from a CONFLICT land here, so
    reading this as "both sides moved" would make the failure message a dead end.
    """
    fake_s3.put(PROMPT, "agreed")
    fake_s3.put(PROMPT_MARKER, md5("something else entirely"))
    _run(fake_s3, _seeds(**{PROMPT: "agreed"}))
    assert fake_s3.objects[PROMPT_MARKER]["body"] == md5("agreed")
    # Content already agrees, so only the marker is rewritten.
    assert fake_s3.puts == [PROMPT_MARKER]


def test_both_sides_changed_is_a_conflict_that_fails_the_apply(fake_s3) -> None:
    """No rule can resolve this without a human, so the apply must stop rather than pick a winner."""
    fake_s3.put(PROMPT, "analyst edit")
    fake_s3.put(PROMPT_MARKER, md5("repo v1"))
    with pytest.raises(seed_push.SeedPushError) as exc:
        _run(fake_s3, _seeds(**{PROMPT: "repo v2"}))
    assert "CONFLICT" in str(exc.value)
    assert PROMPT in str(exc.value)
    # The object must be left exactly as the analyst left it, and nothing written anywhere.
    assert fake_s3.objects[PROMPT]["body"] == "analyst edit"
    assert fake_s3.puts == []


def test_a_multipart_etag_fails_instead_of_comparing_a_wrong_fingerprint(fake_s3) -> None:
    """A `-N` ETag is not an MD5. Comparing it would read every object as edited and never push."""
    fake_s3.put(PROMPT, "old", etag="d41d8cd98f00b204e9800998ecf8427e-2")
    fake_s3.put(PROMPT_MARKER, md5("old"))
    with pytest.raises(seed_push.SeedPushError) as exc:
        _run(fake_s3, _seeds(**{PROMPT: "new"}))
    assert "ETag" in str(exc.value)
    assert fake_s3.puts == []


@pytest.mark.parametrize("encryption", ["aws:kms", None])
def test_non_sse_s3_encryption_fails_before_any_comparison(fake_s3, encryption) -> None:
    """Under SSE-KMS — or with no default encryption readable at all — the ETag is not the MD5, so the
    entire comparison is meaningless and must not be attempted."""
    fake_s3.encryption = encryption
    fake_s3.put(PROMPT, "old")
    fake_s3.put(PROMPT_MARKER, md5("old"))
    with pytest.raises(seed_push.SeedPushError) as exc:
        _run(fake_s3, _seeds(**{PROMPT: "new"}))
    message = str(exc.value)
    assert "AES256" in message or "encryption" in message.lower()
    # Nothing may be written when the premise does not hold.
    assert fake_s3.objects[PROMPT]["body"] == "old"
    assert fake_s3.puts == []


def test_every_conflicting_key_is_reported_in_one_pass(fake_s3) -> None:
    """Stopping at the first conflict makes an operator apply-fix-apply-fix. Report them all."""
    for name in ("a.md", "b.md"):
        fake_s3.put(name, f"analyst {name}")
        fake_s3.put(_marker(name), md5("repo v1"))
    # A third seed that is perfectly fine must not be named as a problem.
    fake_s3.put("c.md", "same")
    fake_s3.put(_marker("c.md"), md5("same"))

    with pytest.raises(seed_push.SeedPushError) as exc:
        _run(fake_s3, _seeds(**{"a.md": "repo v2", "b.md": "repo v2", "c.md": "same"}))
    message = str(exc.value)
    assert "a.md" in message and "b.md" in message
    assert "c.md" not in message
    # A conflict anywhere must not push anything anywhere, including the healthy key.
    assert fake_s3.puts == []


def test_the_md5_is_computed_here_and_never_taken_from_the_caller(fake_s3) -> None:
    """⚠️ The two callers must fingerprint identically.

    The Lambda receives content in its invocation payload and the CLI reads it off disk. If either
    could supply its own digest, a mismatch would silently turn "unchanged" into "push" (clobbering an
    edit) or the reverse (never pushing). A `md5` key in the seed dict must be ignored outright.
    """
    fake_s3.put(PROMPT, "hello")
    fake_s3.put(PROMPT_MARKER, md5("hello"))
    seeds = {PROMPT: {"content": "hello", "source": "repo/x", "md5": md5("something else")}}
    _run(fake_s3, seeds)
    assert fake_s3.puts == []


def test_content_md5_matches_terraform_filemd5_for_utf8(fake_s3) -> None:
    """The repo fingerprint has to agree with Terraform's `filemd5` and with the S3 ETag.

    Non-ASCII matters: encoding the content as anything but UTF-8 would produce a digest that matches
    neither, making every apply see a phantom change on any prompt containing an em dash — which every
    prompt in this repo does.
    """
    text = "policy — with an em dash and a ⚠️ sign\n"
    assert seed_push.content_md5(text) == md5(text)


def test_an_unreadable_encryption_config_is_not_reported_as_unencrypted(fake_s3) -> None:
    """⚠️ AccessDenied and "no default encryption" are different problems and must read differently.

    The first live apply of this reconciliation failed with "default encryption is None, not
    'AES256'" while the bucket was correctly AES256 all along — a blanket `except Exception` had
    turned an IAM failure into a claim about bucket configuration, and sent the investigation at the
    wrong thing entirely.
    """
    fake_s3.access_denied = True
    fake_s3.put(PROMPT, "old")
    with pytest.raises(seed_push.SeedPushError) as exc:
        _run(fake_s3, _seeds(**{PROMPT: "new"}))
    message = str(exc.value)
    assert "AccessDenied" in message
    assert "could not read" in message
    # And it must NOT claim the bucket is unencrypted.
    assert "is None" not in message
    assert fake_s3.puts == []

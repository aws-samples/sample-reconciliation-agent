"""S3-backed live skill catalog for the harness backend (importable from the Lambda zip).

A thin harness-side wrapper over ``backend.recon_core.skill_meta``: the paginated scan, the
frontmatter parse and the 60 s cache all live there. Keeping the parse there matters because the agent
container reads the same catalog through ``agent-blueprint/recon-agent/skills_loader.catalog_s3``: a
second, hand-rolled parser on this side is easy to write and easy to get subtly wrong (flat keys only,
nested ``metadata`` block silently dropped), and the symptom is that switching ``AGENT_BACKEND``
changes what the catalog says about a skill. One parser means it cannot.

``catalog_s3`` returns frontmatter only (the body is stripped) — the harness worker uses it for the
IDP-class → skill match and for validating Tier-1's class hint.
"""

import time

from backend.recon_core.skill_meta import catalog_entry, read_s3_skills


def catalog_s3(bucket: str, prefix: str, *, now=None, s3=None) -> list[dict]:
    """Return the SKILL.md catalog under the S3 prefix (frontmatter metadata, no bodies).

    Cached for ``skill_meta.S3_TTL_SECONDS`` per bucket+prefix so repeated calls within one Lambda
    invocation don't re-list. The clock is ``time.monotonic``, matching ``skills_loader.catalog_s3``
    — both share ``skill_meta._S3_CACHE``, and mixing wall-clock with monotonic expiries in one
    cache would let an entry written by one caller look valid forever to the other.

    :param bucket: assets bucket name.
    :param prefix: S3 prefix (e.g. ``skills/``).
    :param now: injectable clock for tests (``callable() -> float``).
    :param s3: injectable S3 client for tests.
    :returns: list of parsed skill dicts, body stripped (same shape as
        ``skills_loader.catalog_s3``).
    """
    now = now or time.monotonic
    return [catalog_entry(p) for p in read_s3_skills(bucket, prefix, now=now, s3=s3)]

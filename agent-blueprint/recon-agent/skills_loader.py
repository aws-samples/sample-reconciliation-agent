"""Load SKILL.md classification-type skills with progressive disclosure.

Each SKILL.md's frontmatter declares one classification type: ``name``, ``description``, the
gateway ``tools`` the skill uses (a list), and an optional ``model`` override; its body is the
investigation steps. The catalog of these files IS the classification-type registry — there is
no DynamoDB registry. Classification gating uses a single global threshold (below) rather than a
per-skill one.
"""

from pathlib import Path

# Global classification-confidence floor: a model classification below this falls back to
# ``unknown``. One global value, not a per-skill frontmatter field.
DEFAULT_CLASS_THRESHOLD = 0.6

# Frontmatter metadata keys surfaced in the catalog (order-stable).
_META_KEYS = ("name", "description", "tools", "model")


def _parse_list(value: str) -> list[str]:
    """Parse a frontmatter list value ``[a, b, c]`` (or bare ``a, b``) into a list of strings."""
    v = value.strip().strip("[]").strip()
    return [t.strip().strip("'\"") for t in v.split(",") if t.strip()]


def _parse(md: str) -> dict:
    """Parse ``--- key: value --- body`` frontmatter into a classification-type record."""
    fields = {"name": "", "description": "", "tools": "", "model": ""}
    body = md
    if md.startswith("---"):
        fm, _, body = md[3:].partition("---")
        for line in fm.strip().splitlines():
            key, _, value = line.partition(":")
            if key.strip() in fields:
                fields[key.strip()] = value.strip()
    return {
        "name": fields["name"],
        "description": fields["description"],
        "tools": _parse_list(fields["tools"]),
        "model": fields["model"] or None,
        "body": body.strip(),
    }


def catalog(skills_dir: Path) -> list[dict]:
    """L1: classification-type metadata for every SKILL.md (no bodies).

    Returns name, description, tools, model for each skill file. This is the classification-type
    registry the classifier reads.
    """
    return [
        {k: p[k] for k in _META_KEYS}
        for p in (_parse(f.read_text()) for f in sorted(skills_dir.glob("*.md")))
    ]


def load_skills(skills_dir: Path, *, names: list[str]) -> list[dict]:
    """L2: full parsed skill (incl. body) for the named skills only."""
    wanted = set(names)
    return [
        s
        for s in (_parse(f.read_text()) for f in sorted(skills_dir.glob("*.md")))
        if s["name"] in wanted
    ]


# --- S3-backed live skills (editable via the UI without a redeploy) ---------------------------
# The agent reads SKILL.md objects under s3://<bucket>/<prefix> at runtime, cached briefly so a
# hot loop doesn't hit S3 every invocation. The parse/format is identical to the file path.

_S3_CACHE: dict[str, tuple[float, list[dict]]] = {}  # key -> (expires_at, parsed skills)
_S3_TTL_SECONDS = 60


def _load_s3_skills(bucket: str, prefix: str, *, now, s3=None) -> list[dict]:
    """Return all parsed skills under the S3 prefix, cached for _S3_TTL_SECONDS."""
    import boto3

    key = f"{bucket}/{prefix}"
    hit = _S3_CACHE.get(key)
    if hit and now() < hit[0]:
        return hit[1]
    s3 = s3 or boto3.client("s3")
    parsed = []
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            if obj["Key"].endswith(".md"):
                body = s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read().decode()
                parsed.append(_parse(body))
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    _S3_CACHE[key] = (now() + _S3_TTL_SECONDS, parsed)
    return parsed


def catalog_s3(bucket: str, prefix: str, *, now=None, s3=None) -> list[dict]:
    """L1 catalog (metadata only) read live from the S3 skills store."""
    import time

    now = now or time.monotonic
    return [
        {k: p[k] for k in _META_KEYS}
        for p in _load_s3_skills(bucket, prefix, now=now, s3=s3)
    ]


def load_skills_s3(bucket: str, prefix: str, *, names: list[str], now=None, s3=None) -> list[dict]:
    """L2 full skills (incl. body) for the named skills, read live from S3."""
    import time

    now = now or time.monotonic
    wanted = set(names)
    return [s for s in _load_s3_skills(bucket, prefix, now=now, s3=s3) if s["name"] in wanted]

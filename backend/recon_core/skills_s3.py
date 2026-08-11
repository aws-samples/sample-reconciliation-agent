"""S3-backed live skill catalog (shared module, importable from the Lambda zip).

Reads SKILL.md objects under a prefix (any `.md` key), parses their frontmatter, and caches
the result briefly so repeated calls within one Lambda invocation don't re-list. ``catalog_s3``
returns frontmatter only (the body is stripped) — the harness worker uses it for the IDP-class →
skill match, and ``DEFAULT_CLASS_THRESHOLD`` for ``intake._classify``'s threshold check. The
body-bearing loader lives in ``agent-blueprint/recon-agent/skills_loader.py``, which is the copy
the agent container actually ships.
"""

import time
from typing import Any

import boto3

# Global classification-confidence floor (mirrors skills_loader.DEFAULT_CLASS_THRESHOLD).
DEFAULT_CLASS_THRESHOLD = 0.6

_FIELDS = ("name", "description", "tools", "model")
_TTL = 60  # seconds


def _parse_list(value: str) -> list[str]:
    """Parse a frontmatter list value ``[a, b, c]`` (or bare ``a, b``) into a list of strings."""
    v = (value or "").strip().strip("[]").strip()
    return [t.strip().strip("'\"") for t in v.split(",") if t.strip()]


def _parse(md: str) -> dict:
    """Parse ``--- key: value --- body`` frontmatter into a classification-type record."""
    fields: dict[str, Any] = {f: "" for f in _FIELDS}
    lines = md.split("\n")
    in_fm, body_start = False, 0
    for i, line in enumerate(lines):
        if line.strip() == "---":
            if not in_fm:
                in_fm = True
            else:
                body_start = i + 1
                break
        elif in_fm:
            key, _, value = line.partition(":")
            if key.strip() in fields:
                fields[key.strip()] = value.strip()
    fields["tools"] = _parse_list(fields["tools"])
    fields["model"] = fields["model"] or None
    fields["body"] = "\n".join(lines[body_start:]).strip()
    return fields


_CACHE: dict[str, tuple[float, list[dict]]] = {}


def catalog_s3(bucket: str, prefix: str, *, now=None, s3=None) -> list[dict]:
    """Return the SKILL.md catalog under the S3 prefix (frontmatter metadata, no bodies).

    Cached for 60 s per bucket+prefix so repeated calls within one Lambda invocation don't re-list.

    :param bucket: assets bucket name.
    :param prefix: S3 prefix (e.g. ``skills/``).
    :param now: injectable clock for tests (``callable() -> float``).
    :param s3: injectable S3 client for tests.
    :returns: list of parsed skill dicts (same shape as ``skills_loader.catalog_s3``).
    """
    now = now or time.time
    key = f"{bucket}/{prefix}"
    hit = _CACHE.get(key)
    if hit and hit[0] > now():
        return hit[1]
    s3 = s3 or boto3.client("s3")
    parsed: list[dict] = []
    kwargs: dict = {"Bucket": bucket, "Prefix": prefix}
    while True:
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            if obj["Key"].endswith(".md"):
                body = s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read().decode()
                p = _parse(body)
                if p.get("name"):
                    parsed.append(p)
        if not resp.get("IsTruncated"):
            break
        kwargs["ContinuationToken"] = resp["NextContinuationToken"]
    _CACHE[key] = (now() + _TTL, parsed)
    return [{k: v for k, v in p.items() if k != "body"} for p in parsed]

"""Load the parsing agent's SKILL.md catalog and prompt text from S3.

Skills live at ``s3://<assets>/skills/<name>/SKILL.md`` and are edited from the Skills tab (via
approved proposals), so they are read fresh on every parse: an approved skill change must apply
to the very next email. The frontmatter parser here is deliberately tiny -- flat ``key: value``
lines, plus the one-line flow mapping ``metadata: { tier: "...", applies_to: [...] }`` -- because
the Lambda ships with boto3 and the standard library alone, and nothing else in a SKILL.md header
is read by the pipeline. ``metadata.tier`` and ``metadata.applies_to`` decide which skills an
email gets (:func:`select_skills`); a skill without them is always loaded.
"""

import logging
import posixpath

logger = logging.getLogger(__name__)

FORMAT_TIER = "format"
# Source kinds that load every skill: nobody has said which format a manual email follows.
LOAD_ALL_SOURCE_KINDS = ("manual",)


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def _split_top_level(text: str) -> list[str]:
    """Split on commas that are outside brackets and quotes (``a: [x, y], b: "p, q"`` -> 2 items)."""
    parts, current, depth, quote = [], [], 0, None
    for ch in text:
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if "".join(current).strip():
        parts.append("".join(current))
    return parts


def _parse_flow_mapping(text: str) -> dict[str, str | list[str]]:
    """Read a one-line YAML flow mapping of scalars and scalar lists; anything else is dropped."""
    out: dict[str, str | list[str]] = {}
    for item in _split_top_level(text.strip()[1:-1]):
        key, sep, value = item.partition(":")
        if not sep or not key.strip():
            continue
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            out[key.strip()] = [_unquote(v) for v in _split_top_level(value[1:-1]) if v.strip()]
        else:
            out[key.strip()] = _unquote(value)
    return out


def parse_frontmatter(md: str) -> tuple[dict, str]:
    """Split ``--- <key: value lines> --- <body>`` into ``(meta, body)``.

    Only top-level ``key: value`` lines are read; indented lines (nested block mappings) and list
    items are skipped rather than misread. A value written as a one-line flow mapping
    (``metadata: { tier: "format", applies_to: ["bank-notice"] }``) becomes a nested dict of
    strings and string lists. Other values lose surrounding quotes. Text without an opening fence
    is all body with empty meta.

    :param md: the SKILL.md text.
    :returns: the frontmatter mapping and the body with surrounding whitespace stripped.
    """
    if not md.startswith("---"):
        return {}, md.strip()
    lines = md.splitlines()
    meta: dict = {}
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[index + 1 :]).strip()
        if not line or line[0].isspace() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if not value:
            continue  # "metadata:" with nothing inline opens a nested block, which is skipped
        if value.startswith("{") and value.endswith("}"):
            meta[key.strip()] = _parse_flow_mapping(value)
        else:
            meta[key.strip()] = _unquote(value)
    # Unterminated fence: treat the whole file as body so a half-edited skill still reaches the model.
    return {}, md.strip()


def select_skills(skills: list[dict], source_kind: str | None) -> list[dict]:
    """Keep the skills that apply to an email of ``source_kind``.

    Core and reference skills always load. A ``format``-tier skill loads only when its
    ``metadata.applies_to`` names the source kind: the news-alert and bank-notice reading guides
    contradict each other on where facts sit, and the model was promised exactly one. A skill
    with no ``metadata`` (or no tier / applies_to) is never dropped, so a hand-written SKILL.md
    still reaches the model. A ``manual`` email, or one with no source kind, loads everything.

    :param skills: :func:`list_skills` output.
    :param source_kind: the email's ``source_kind`` (design section 4).
    """
    if not source_kind or source_kind in LOAD_ALL_SOURCE_KINDS:
        return list(skills)
    selected = []
    for skill in skills:
        meta = skill.get("metadata") if isinstance(skill.get("metadata"), dict) else {}
        applies_to = meta.get("applies_to")
        if (
            meta.get("tier") == FORMAT_TIER
            and isinstance(applies_to, list)
            and source_kind not in applies_to
        ):
            continue
        selected.append(skill)
    return selected


def list_skills(s3, bucket: str, prefix: str) -> list[dict]:
    """Return every SKILL.md under the prefix as ``{name, description, metadata, body}``, by name.

    A skill with no ``name`` in its frontmatter takes the name of the directory it sits in
    (``skills/deal-parsing/SKILL.md`` -> ``deal-parsing``), so a file saved without frontmatter
    still loads. Objects that are not Markdown are ignored.

    :param s3: boto3 S3 client.
    :param bucket: assets bucket.
    :param prefix: key prefix, e.g. ``skills/``.
    """
    skills = []
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            key = obj["Key"]
            if not key.lower().endswith(".md"):
                continue
            md = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
            meta, body = parse_frontmatter(md)
            name = meta.get("name") or posixpath.basename(posixpath.dirname(key))
            if not name:
                logger.warning(
                    "skipping skill s3://%s/%s: no name in frontmatter or path", bucket, key
                )
                continue
            metadata = meta.get("metadata")
            skills.append(
                {
                    "name": name,
                    "description": meta.get("description", ""),
                    "metadata": metadata if isinstance(metadata, dict) else {},
                    "body": body,
                }
            )
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return sorted(skills, key=lambda s: s["name"])


def load_text(s3, bucket: str, key: str, default: str) -> str:
    """Read a UTF-8 text object, returning ``default`` when the key does not exist.

    Used for the parser system prompt: an environment whose prompt was never seeded (or was
    deleted from the Skills tab) still parses with the built-in prompt instead of failing.
    """
    try:
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        logger.info("s3://%s/%s not found; using the built-in default", bucket, key)
        return default

"""Load the parsing agent's SKILL.md catalog and prompt text from S3.

Skills live at ``s3://<assets>/skills/<name>/SKILL.md`` and are edited from the Skills tab (via
approved proposals), so they are read fresh on every parse: an approved skill change must apply
to the very next email. The frontmatter is parsed by ``backend.recon_core.skill_meta`` -- the same
``yaml.safe_load`` parser the recon app uses -- so one SKILL.md means one thing in both apps. Flat
``key: value`` lines, the one-line flow mapping ``metadata: { tier: "...", applies_to: [...] }``
the seed skills use and the block form of the same ``metadata`` all parse to the same record.
Values are YAML scalars, not raw text: an unquoted ``description`` is cut at a `` #`` (a YAML
comment) with nothing logged, and one with a ``: `` in it, or opening with ``* @ ` [ { | > %``, is
not valid YAML at all. A file whose frontmatter is not valid YAML is logged and left out of the
catalog rather than half-read; the authoring rule (double-quote such a description) is in
``agent-blueprint/deal-pipeline-agent/README.md``, "Skill frontmatter". ``metadata.tier`` and
``metadata.applies_to`` decide which skills an email gets (:func:`select_skills`); a skill
without them is always loaded.
"""

import time

from backend.recon_core.s3_text import read_text
from backend.recon_core.skill_meta import NAME_FALLBACK_DIRECTORY, read_s3_skills

FORMAT_TIER = "format"
# Source kinds that load every skill: nobody has said which format a manual email follows.
LOAD_ALL_SOURCE_KINDS = ("manual",)
# The part of a parsed skill record the parsing agent reads (``select_skills`` and
# ``agent.build_user_message``). The recon-only keys (``tools``, ``model``, ``evidence_steps``,
# ``result``) stop here so nothing downstream comes to depend on them.
_SKILL_KEYS = ("name", "description", "metadata", "body")


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

    Delegates to :func:`backend.recon_core.skill_meta.read_s3_skills` with the two options recon
    leaves at their defaults. ``name_fallback="directory"``: a skill with no ``name`` in its
    frontmatter takes the name of the directory it sits in (``skills/deal-parsing/SKILL.md`` ->
    ``deal-parsing``), so a file saved without frontmatter still loads. ``ttl_seconds=0``: the
    shared 60 s catalog cache is bypassed, so an approved Skills-tab edit is visible on the very
    next parse. Objects that are not Markdown are ignored; a Markdown object whose frontmatter is
    not valid YAML is logged at ERROR and skipped, and the remaining skills still load.

    :param s3: boto3 S3 client.
    :param bucket: assets bucket.
    :param prefix: key prefix, e.g. ``skills/``.
    """
    skills = read_s3_skills(
        bucket,
        prefix,
        now=time.monotonic,
        s3=s3,
        name_fallback=NAME_FALLBACK_DIRECTORY,
        ttl_seconds=0,
    )
    return sorted(({k: s[k] for k in _SKILL_KEYS} for s in skills), key=lambda s: s["name"])


def load_text(s3, bucket: str, key: str, default: str) -> str:
    """Read a UTF-8 text object, returning ``default`` when the key does not exist.

    Used for the parser system prompt: an environment whose prompt was never seeded (or was
    deleted from the Skills tab) still parses with the built-in prompt instead of failing.
    """
    return read_text(s3, bucket, key, default=default, tolerate_codes=("NoSuchKey",))

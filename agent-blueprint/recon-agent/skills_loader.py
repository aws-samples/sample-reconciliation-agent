"""Load SKILL.md classification-type skills with progressive disclosure.

Each SKILL.md's frontmatter is real YAML declaring one classification type: ``name``,
``description``, the gateway ``tools`` the skill uses (a list), an optional ``model`` override, and
an optional nested ``metadata`` block; its body is the investigation steps. The catalog of these
files IS the classification-type registry — there is no DynamoDB registry. Classification is NOT
gated by a confidence threshold at all, global or per-skill: see ``classifier.py``, which never asks
the model how sure it is, because rewriting a low-confidence pick to ``unknown`` would discard the
whole investigation on a self-reported number. Escalation is decided downstream instead, from the
computed evidence-completeness score.

``metadata.tier`` inside that block records what kind of skill it is (``break-type``, ``probe``,
``resolution``, ``fallback``). Nothing routes on it — Tier-1 classifies with a plain-Python rule
table (``backend/tier1/classify.py``) that never reads this catalog, and its class reaches Tier-2 as
a hint on the investigation prompt only. ``backend/recon_core/skill_meta`` owns the parsing for this
module and for the harness backend's catalog, so the two Tier-2 backends cannot disagree about a
skill's frontmatter.
"""

from pathlib import Path

from backend.recon_core.skill_meta import catalog_entry as _entry
from backend.recon_core.skill_meta import parse_skill as _parse
from backend.recon_core.skill_meta import read_s3_skills as _load_s3_skills


def catalog(skills_dir: Path) -> list[dict]:
    """L1: classification-type metadata for every SKILL.md (no bodies).

    Returns name, description, tools, model and the nested metadata block for each skill file.
    This is the classification-type registry the classifier reads.

    :param skills_dir: directory holding the SKILL.md files.
    :returns: one metadata dict per skill, body stripped.
    """
    return [_entry(p) for p in (_parse(f.read_text()) for f in sorted(skills_dir.glob("*.md")))]


def load_skills(skills_dir: Path, *, names: list[str]) -> list[dict]:
    """L2: full parsed skill (incl. body) for the named skills only.

    :param skills_dir: directory holding the SKILL.md files.
    :param names: skill names to load; anything else is skipped.
    :returns: the matching parsed skills, bodies included.
    """
    wanted = set(names)
    return [
        s
        for s in (_parse(f.read_text()) for f in sorted(skills_dir.glob("*.md")))
        if s["name"] in wanted
    ]


# --- S3-backed live skills (editable via the UI without a redeploy) ---------------------------
# The paginated scan, the parse and the 60s cache all live in backend/recon_core/skill_meta so the
# agent and the agent-worker share one implementation. These two functions are the agent-side
# signatures their callers already use.


def catalog_s3(bucket: str, prefix: str, *, now=None, s3=None) -> list[dict]:
    """L1 catalog (metadata only) read live from the S3 skills store.

    :param bucket: assets bucket holding the live skills.
    :param prefix: key prefix (e.g. ``"skills/"``).
    :param now: monotonic clock callable (injected in tests).
    :param s3: boto3 S3 client (injected in tests).
    :returns: one metadata dict per skill, body stripped.
    """
    import time

    now = now or time.monotonic
    return [_entry(p) for p in _load_s3_skills(bucket, prefix, now=now, s3=s3)]


def load_skills_s3(bucket: str, prefix: str, *, names: list[str], now=None, s3=None) -> list[dict]:
    """L2 full skills (incl. body) for the named skills, read live from S3.

    :param bucket: assets bucket holding the live skills.
    :param prefix: key prefix (e.g. ``"skills/"``).
    :param names: skill names to load; anything else is skipped.
    :param now: monotonic clock callable (injected in tests).
    :param s3: boto3 S3 client (injected in tests).
    :returns: the matching parsed skills, bodies included.
    """
    import time

    now = now or time.monotonic
    wanted = set(names)
    return [s for s in _load_s3_skills(bucket, prefix, now=now, s3=s3) if s["name"] in wanted]

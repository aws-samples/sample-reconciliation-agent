"""Shared SKILL.md frontmatter parsing and S3-backed live skill loading.

Read by the Tier-2 agent's skill loader (``agent-blueprint/recon-agent/skills_loader.py``) and by
the harness backend's catalog reader, so both Tier-2 backends see one parse of one catalog. The deal
pipeline's ``backend/deal_pipeline/skills_loader.py`` reads its own S3 catalog through
``read_s3_skills`` too, with two options (``name_fallback``, ``ttl_seconds``) that default to recon's
behaviour, so one SKILL.md means one thing in both apps.

Tier-1 does NOT read this module. It classifies with a plain-Python rule table
(``backend/tier1/classify.py``) that never touches the catalog, so a catalog edit cannot change
Tier-1's triage. There is deliberately no predicate DSL here for Tier-1 to route on: the
frontmatter comes from a UI-editable S3 file, and routing decisions must not be expressible in one.

**Untrusted input.** Skill files are editable from the UI and read live from S3, so this module is
on an untrusted-input path: ``yaml.safe_load``, never ``yaml.load``.
"""

import logging
import posixpath

import yaml

from backend.recon_core.schema import EvidenceStep, SkillResultSpec

_LOG = logging.getLogger(__name__)

# Flat frontmatter keys the catalog surfaces (order-stable). ``metadata`` is the nested escape
# hatch defined by the Agent Skills spec (``tier``, ``autonomy``).
META_KEYS = ("name", "description", "tools", "model", "metadata", "evidence_steps", "result")


def catalog_entry(skill: dict) -> dict:
    """Project one parsed skill onto ``META_KEYS`` as JSON-native values (body stripped).

    ``parse_skill`` deliberately returns pydantic models for ``evidence_steps`` and ``result``:
    typing them at the parse boundary is what makes a malformed declaration fail loudly instead of
    scoring wrongly. But the catalog leaves the process — it is published as
    ``skills-catalog.json`` at build time and returned by the skills API — and a model in it raises
    ``TypeError: Object of type EvidenceStep is not JSON serializable``.

    Every catalog projection goes through here so the two Tier-2 backends and the build step cannot
    produce three different shapes. Dumping with ``mode="json"`` rather than ``default=str`` matters:
    ``default=str`` would emit the model's repr as the whole step and the UI would render a string
    where it expects ``{id, description, required}``.

    :param skill: a ``parse_skill`` record.
    :returns: the ``META_KEYS`` subset, with pydantic values converted to plain dicts.
    """
    entry = {k: skill[k] for k in META_KEYS}
    entry["evidence_steps"] = [s.model_dump(mode="json") for s in entry["evidence_steps"]]
    if entry["result"] is not None:
        entry["result"] = entry["result"].model_dump(mode="json")
    return entry


def step_field(step: EvidenceStep | dict, name: str):
    """Read one field off an evidence step that may be a model OR a plain dict.

    Both shapes are in circulation by design: ``parse_skill`` returns ``EvidenceStep`` models (the
    runtime backend loads skills that way), while :func:`catalog_entry` projects them to JSON dicts
    (the harness backend only ever sees the catalog, because it has no skill-loading tool). Anything
    shared by both backends therefore has to accept either, and doing that in one place is what keeps
    the two from drifting.

    Used by :func:`evidence_step_block` here AND by ``confidence.evidence_completeness``, which is the
    reason it is public. Reading ``s.id``/``s.required`` off the step directly works only on the
    runtime path; the harness path hands that scorer catalog dicts and raises ``AttributeError:
    'dict' object has no attribute 'required'``. Note that an ``unknown`` classification declares no
    steps and returns before the loop, so that failure hides until classification works.

    :param step: an ``EvidenceStep`` or its ``model_dump(mode="json")`` dict.
    :param name: the field name (``id``/``description``/``required``).
    :returns: the field value.
    :raises KeyError: when a dict step is missing the field — a malformed declaration must fail
        loudly rather than render an empty id the model would then be asked to echo back.
    """
    return step[name] if isinstance(step, dict) else getattr(step, name)


def evidence_step_block(skill: dict) -> str:
    """Render one skill's DECLARED evidence-step ids for a prompt ('' when it declares none).

    Shared by BOTH Tier-2 backends on purpose. The ids live in frontmatter, which ``parse_skill``
    strips out of ``body``, so without this block neither backend's prompt shows them while both
    prompts ask the model to report ``step_id`` values "from your skill's evidence steps". The model
    then invents plausible ids from the skill's PROSE instead — ``account_name_match`` (the prose says
    "Account name") for a skill declaring ``expected_entry_match``, or ``ledger_lookup`` and
    ``amount_tolerance_check``. Every invented id is unscoreable, so the prescribed step it stood for
    counts as never attempted and the score collapses.

    It lives here, next to the parser that owns the declaration, rather than in either backend:
    ``evidence_completeness`` scores both backends with one function, so the two must be ASKED for
    their evidence with one function too, or the scores diverge for a reason that has nothing to do
    with the evidence.

    Required/optional is stated because only required steps are the score's denominator: an agent that
    spends its tool budget on an optional step instead of a required one scores lower for no gain.

    :param skill: a ``parse_skill`` record or a :func:`catalog_entry` projection; reads
        ``evidence_steps``.
    :returns: the prompt block (newline-terminated), or '' when the skill prescribes no steps.
    """
    declared = skill.get("evidence_steps") or []
    if not declared:
        return ""
    lines = "\n".join(
        f"- `{step_field(s, 'id')}` "
        f"({'required' if step_field(s, 'required') else 'optional'}): "
        f"{step_field(s, 'description')}"
        for s in declared
    )
    return (
        "\nEvidence steps this skill prescribes — report each one by its EXACT id below, in this "
        f"order. Do not invent an id and do not rename one:\n{lines}\n"
    )


def _as_list(value) -> list[str]:
    """Coerce a frontmatter ``tools`` value to a list of strings.

    Accepts both forms a SKILL.md author can reasonably write: a real YAML list (``[a, b]``) and a
    bare comma-separated string (``a, b``). Skill files are hand-edited through the UI, so a parser
    that took only one form would reject valid-looking frontmatter.

    :param value: the raw parsed value (list, str, or None).
    :returns: the tool names, whitespace- and quote-stripped.
    """
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if not value:
        return []
    return [t.strip().strip("'\"") for t in str(value).split(",") if t.strip()]


def _parse_evidence_steps(value) -> list[EvidenceStep]:
    """Validate the frontmatter ``evidence_steps`` block into typed steps.

    :param value: the raw parsed value (list of mappings, or None when the key is absent).
    :returns: the declared steps in file order; empty when the key is absent.
    :raises ValueError: when the block is not a list of mappings, when a step will not validate,
        or when two steps share an id — a duplicate id would be counted twice by the
        evidence-completeness denominator.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"evidence_steps must be a list, got {type(value).__name__}")
    steps: list[EvidenceStep] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f"evidence_steps[{index}] must be a mapping")
        try:
            steps.append(EvidenceStep.model_validate(raw))
        except Exception as exc:  # pydantic ValidationError
            raise ValueError(f"evidence_steps[{index}] is invalid: {exc}") from exc
    ids = [s.id for s in steps]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise ValueError(f"evidence_steps has duplicate ids: {sorted(duplicates)}")
    return steps


def _parse_result(value) -> SkillResultSpec | None:
    """Validate the frontmatter ``result`` block, or None when the skill declares none.

    A skill with no ``result`` block is treated as making no cardinality claim; the caller decides
    the default. Deliberately NOT defaulted here — a silent single_match default would make the
    ranked-set skills the exception rather than a declared choice.

    :param value: the raw parsed value (mapping, or None when absent).
    :returns: the validated spec, or None.
    :raises ValueError: when present but not a valid spec.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"result must be a mapping, got {type(value).__name__}")
    try:
        return SkillResultSpec.model_validate(value)
    except Exception as exc:  # pydantic ValidationError
        raise ValueError(f"result is invalid: {exc}") from exc


def parse_skill(md: str) -> dict:
    """Parse ``--- <yaml> --- <body>`` into a skill record.

    :param md: the full SKILL.md text.
    :returns: ``{name, description, tools, model, metadata, evidence_steps, result, body}``.
        Missing flat keys become ``""``/``None``; a missing ``metadata`` block becomes ``{}``;
        a missing ``evidence_steps`` block becomes ``[]`` and a missing ``result`` becomes ``None``.
    :raises ValueError: when a frontmatter block is present but is not a YAML mapping, or when it
        will not parse at all. Fail loudly — a skill that parses to an empty record is a skill the
        agent silently cannot select.
    """
    body, fm = md, {}
    if md.startswith("---"):
        # partition() finds the FIRST "---" after the opening fence. A frontmatter VALUE containing
        # "---" therefore truncates the block; see the pinned test for that known limitation.
        raw, _, body = md[3:].partition("---")
        try:
            fm = yaml.safe_load(raw) or {}
        except yaml.YAMLError as exc:
            raise ValueError(f"unparseable SKILL.md frontmatter: {exc}") from exc
        if not isinstance(fm, dict):
            raise ValueError(f"SKILL.md frontmatter must be a mapping, got {type(fm).__name__}")
    meta = fm.get("metadata") or {}
    if not isinstance(meta, dict):
        raise ValueError("SKILL.md frontmatter `metadata` must be a mapping")
    return {
        "name": str(fm.get("name") or ""),
        "description": str(fm.get("description") or ""),
        "tools": _as_list(fm.get("tools")),
        "model": fm.get("model") or None,
        "metadata": meta,
        "evidence_steps": _parse_evidence_steps(fm.get("evidence_steps")),
        "result": _parse_result(fm.get("result")),
        "body": body.strip(),
    }


# ---------------------------------------------------------------------------------
# S3-backed live skills
# ---------------------------------------------------------------------------------
# Skills are read from s3://<bucket>/<prefix> at runtime so a break type ships without a
# redeploy. Cached per process because both Tier-2 backends read the catalog on every invocation.

_S3_CACHE: dict[str, tuple[float, list[dict]]] = {}
S3_TTL_SECONDS = 60

# The one ``name_fallback`` value ``read_s3_skills`` accepts besides None. Names a skill that declares
# no ``name`` after the directory its object sits in (``skills/deal-parsing/SKILL.md`` ->
# ``deal-parsing``), which is what the deal pipeline's ``skills/<name>/SKILL.md`` layout wants; recon
# passes nothing and keeps dropping nameless skills.
NAME_FALLBACK_DIRECTORY = "directory"


def _parse_s3_skill(
    *, bucket: str, key: str, md: str, name_fallback: str | None = None
) -> dict | None:
    """Parse one skill object read from S3, or return None when it is unusable.

    Skills in S3 are editable from the UI, so one typo in one file must not take the catalog down
    with it: ``parse_skill`` raises, and an exception here would propagate out of every Tier-2
    invocation and stop all reconciliation — which turns a text field into a denial of service. So
    an S3 skill that will not parse is logged at ERROR with its key and left out of the catalog:
    loud in CloudWatch, survivable at runtime. Skills read from the repo (``skills_loader.catalog``)
    still raise, because those are deploy-time artifacts the test suite covers.

    A record with no ``name`` is dropped for the same reason — the classifier matches on name, so a
    nameless skill is one no caller can ever select, and leaving it in only pads the prompt. The
    deal pipeline selects by ``metadata`` rather than by name and promises that a file saved without
    frontmatter still loads, so it passes ``name_fallback="directory"`` and the record is named after
    its directory instead; a key with no directory to fall back to is still dropped.

    :param bucket: bucket the object came from (used in the log line and the directory fallback).
    :param key: object key (used in the log line and the directory fallback).
    :param md: the raw SKILL.md text.
    :param name_fallback: ``"directory"`` to name a nameless skill after the directory its object
        sits in; None (the default) drops it.
    :returns: the parsed skill record, or None when it cannot be parsed or declares no name.
    """
    try:
        skill = parse_skill(md)
    except ValueError:
        _LOG.exception("skipping unparseable skill s3://%s/%s", bucket, key)
        return None
    if not skill["name"] and name_fallback == NAME_FALLBACK_DIRECTORY:
        skill["name"] = posixpath.basename(posixpath.dirname(key))
    if not skill["name"]:
        _LOG.error("skipping skill s3://%s/%s: frontmatter declares no `name`", bucket, key)
        return None
    return skill


def read_s3_skills(
    bucket: str,
    prefix: str,
    *,
    now,
    s3=None,
    name_fallback: str | None = None,
    ttl_seconds: int | None = None,
) -> list[dict]:
    """Return every parsed SKILL.md under the S3 prefix, cached for ``S3_TTL_SECONDS``.

    The scan is recursive over the prefix, so both the flat ``skills/<name>.md`` layout and the
    Agent-Skills ``skills/<name>/SKILL.md`` layout are picked up by the same call.

    The cache is per PROCESS, not per invocation, so a warm Lambda container and a cold one can
    disagree about the catalog for up to ``S3_TTL_SECONDS`` after an edit — two items submitted a
    second apart can be served different catalogs. Acceptable because the catalog only widens or
    narrows the menu the agent picks from, and every consumer of the catalog within one invocation
    reads the same cached list (this is a plain dict lookup, so it cannot change mid-invocation).

    Objects that will not parse, or that declare no ``name``, are logged and skipped rather than
    raised — see ``_parse_s3_skill`` for why the S3 path differs from the repo path here.

    Two options exist for the deal pipeline, whose skills carry the same frontmatter but are
    consumed differently. Both default to recon's behaviour, so a caller that passes neither reads
    exactly what it read before the options existed:

    - ``name_fallback="directory"`` keeps a skill that declares no ``name`` by naming it after the
      directory its object sits in (``skills/deal-parsing/SKILL.md`` -> ``deal-parsing``), so a file
      saved without frontmatter still loads. None (the default) drops it, as above. A fallback read
      is cached under its own key, so it and a default read of the same prefix never serve each
      other's list.
    - ``ttl_seconds`` overrides the cache TTL. ``0`` bypasses the cache entirely — the prefix is
      listed and every object read on each call, and nothing is stored — for a caller that has
      promised its users an edit is live on the very next run. None (the default) is
      ``S3_TTL_SECONDS``.

    :param bucket: assets bucket holding the live skills.
    :param prefix: key prefix (e.g. ``"skills/"``).
    :param now: monotonic clock callable (injected in tests).
    :param s3: boto3 S3 client (injected in tests); built lazily when None.
    :param name_fallback: None (drop nameless skills) or ``"directory"``; see above.
    :param ttl_seconds: cache TTL override; None for ``S3_TTL_SECONDS``, ``0`` to bypass the cache.
    :returns: parsed skill records (incl. bodies), skipping the unusable ones.
    :raises ValueError: when ``name_fallback`` is neither None nor ``"directory"`` — a misspelt
        option must not silently degrade to "drop the skill".
    """
    import boto3

    if name_fallback not in (None, NAME_FALLBACK_DIRECTORY):
        raise ValueError(
            f"unknown name_fallback {name_fallback!r}: expected None or {NAME_FALLBACK_DIRECTORY!r}"
        )
    ttl = S3_TTL_SECONDS if ttl_seconds is None else ttl_seconds
    key = f"{bucket}/{prefix}" if name_fallback is None else f"{bucket}/{prefix}#{name_fallback}"
    if ttl > 0:
        hit = _S3_CACHE.get(key)
        if hit and now() < hit[0]:
            return hit[1]
    s3 = s3 or boto3.client("s3")
    parsed, token = [], None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            if obj["Key"].endswith(".md"):
                body = s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read().decode()
                skill = _parse_s3_skill(
                    bucket=bucket, key=obj["Key"], md=body, name_fallback=name_fallback
                )
                if skill:
                    parsed.append(skill)
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    if ttl > 0:
        _S3_CACHE[key] = (now() + ttl, parsed)
    return parsed

"""One prompt, two backends: the shared core plus a per-backend calling contract.

The policy text (role, skills-are-procedures, workflow, autonomy semantics, principles) lives in
exactly ONE editable artifact — ``s3://<assets>/system-prompt.md`` — and BOTH Tier-2 backends read
it. Previously each backend owned a full copy, and the copies drifted: the runtime copy said
"skills are NOT categories" while the harness copy still framed classification as picking one, and
a config version deployed for the harness left the runtime untouched. Drift here is invisible until
an agent behaves differently depending on which backend happened to be active.

What is NOT shared is each backend's calling contract — the harness needs the ``submit_proposal``
field list and the prefixed gateway tool names, which are meaningless to the runtime (it calls
tools through Strands). That mechanical text is appended from
``s3://<assets>/system-prompt-harness.md``, and is deliberately kept OUT of the core so that an
optimizer-generated prompt applied to the core can never drop the harness's contract.

Precedence (both backends, one rule): the core object is authoritative. Deploying a harness config
version WRITES its ``system_prompt`` into the core object (see the frontend deploy route) instead
of overriding the prompt only at invoke time — that is what keeps the two backends in sync.
"""

# The shared policy object. Written by the UI prompt editor and by a config-version deploy.
CORE_PROMPT_KEY = "system-prompt.md"

# The harness-only calling contract, appended after the core. Not optimizable, not shared.
HARNESS_CONTRACT_KEY = "system-prompt-harness.md"


def compose_prompt(*, core: str, contract: str = "") -> str:
    """Join the shared core policy with an optional per-backend calling contract.

    :param core: text of the shared core object (``system-prompt.md``).
    :param contract: text of the backend's calling contract ('' for the runtime backend).
    :returns: the full system prompt to send to the model.
    :raises ValueError: if the core is empty — an agent running with only a calling contract, or
        with nothing at all, would investigate without any policy. Fail loudly instead.
    """
    if not core.strip():
        raise ValueError(
            f"the shared core system prompt ({CORE_PROMPT_KEY}) is empty — refusing to invoke the "
            "agent with no policy"
        )
    if not contract.strip():
        return core.strip()
    return f"{core.strip()}\n\n{contract.strip()}"

"""Tests for the shared prompt core + per-backend calling contract composition.

The regression these lock in: each Tier-2 backend used to own a full copy of the system prompt, and
the copies drifted (one said "skills are NOT categories", the other framed classification as
picking one). The policy half must now come from ONE object, with only the harness's calling
contract appended.
"""

import pytest

from backend.recon_core.prompt_source import (
    CORE_PROMPT_KEY,
    HARNESS_CONTRACT_KEY,
    compose_prompt,
)


def test_runtime_backend_gets_the_core_alone() -> None:
    """No contract (runtime path) → the core policy, unchanged apart from trimming."""
    assert compose_prompt(core="  policy text\n") == "policy text"


def test_harness_backend_appends_the_contract_after_the_core() -> None:
    """Contract goes AFTER the policy: it overrides the generic step wording it references."""
    out = compose_prompt(core="policy text", contract="# This backend's calling contract\nsubmit")
    assert out == "policy text\n\n# This backend's calling contract\nsubmit"
    assert out.index("policy text") < out.index("calling contract")


def test_blank_contract_is_not_appended() -> None:
    """A whitespace-only contract object must not leave trailing separator noise."""
    assert compose_prompt(core="policy text", contract="   \n") == "policy text"


def test_empty_core_fails_loudly() -> None:
    """An agent with a calling contract but no policy would investigate with no instructions."""
    with pytest.raises(ValueError, match=CORE_PROMPT_KEY):
        compose_prompt(core="  \n", contract="submit_proposal contract")


def test_keys_are_distinct_artifacts() -> None:
    """The contract must live in its own object — merging it into the core would let an applied
    prompt recommendation paraphrase the submit_proposal field list into the shared policy."""
    assert CORE_PROMPT_KEY != HARNESS_CONTRACT_KEY

"""Test doubles for the deal pipeline suite.

Imported (not fixtures) so a test can script the model's turns inline next to its assertions:

    bedrock = FakeBedrock([lookup_turn("Northwind Automotive"), stage_turn({...})])
"""

import copy


def tool_use(name: str, tool_input: dict, tool_use_id: str = "tu-1") -> dict:
    """One ``toolUse`` content block as Converse returns it."""
    return {"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input}}


def text_block(text: str) -> dict:
    return {"text": text}


def lookup_turn(issuer_name: str) -> list[dict]:
    """An assistant turn that only calls ``lookup_security_master``."""
    return [tool_use("lookup_security_master", {"issuer_name": issuer_name}, "tu-lookup")]


def stage_turn(
    fields: dict, evidence: dict | None = None, assumptions: list | None = None
) -> list[dict]:
    """An assistant turn that calls ``stage_deal`` with the given payload."""
    payload = {"fields": fields, "evidence": evidence or {}, "assumptions": assumptions or []}
    return [tool_use("stage_deal", payload, "tu-stage")]


def truncated_turn(content: list[dict] | None = None) -> dict:
    """A reply Bedrock cut off at ``maxTokens``: ``stopReason`` is ``max_tokens``.

    The content defaults to text only, the shape a reply truncated before its tool call has;
    pass a ``stage_deal`` block with an empty input to model the other observed shape.
    """
    return {"content": content or [text_block("Staging the deal now")], "stopReason": "max_tokens"}


class FakeBedrock:
    """Scripted stand-in for the ``bedrock-runtime`` client.

    Each ``converse`` call returns the next scripted turn as an assistant message: a list of
    content blocks (``stopReason`` derived: ``tool_use`` when any block is a tool call), or a
    ``{"content", "stopReason"}`` dict when the test needs a specific stop reason (see
    :func:`truncated_turn`). A scripted exception is raised instead, which is how transport
    failures are simulated. Every call's keyword arguments are deep-copied into ``calls`` so a
    test can inspect the exact messages the agent sent, even though the agent keeps appending to
    its own list.
    """

    def __init__(self, turns: list):
        self.turns = list(turns)
        self.calls: list[dict] = []

    def converse(self, **kwargs) -> dict:
        self.calls.append(copy.deepcopy(kwargs))
        if not self.turns:
            raise AssertionError("FakeBedrock ran out of scripted turns")
        turn = self.turns.pop(0)
        if isinstance(turn, BaseException):
            raise turn
        if isinstance(turn, dict):
            content, stop_reason = list(turn["content"]), turn["stopReason"]
        else:
            content = list(turn)
            stop_reason = "tool_use" if any("toolUse" in block for block in content) else "end_turn"
        return {
            "output": {"message": {"role": "assistant", "content": content}},
            "stopReason": stop_reason,
            "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        }

    def user_text(self, call_index: int) -> str:
        """Concatenated text blocks of the LAST user message sent on call ``call_index``."""
        message = self.calls[call_index]["messages"][-1]
        assert message["role"] == "user"
        return "\n".join(block["text"] for block in message["content"] if "text" in block)

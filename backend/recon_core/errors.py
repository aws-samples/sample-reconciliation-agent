"""Shared domain errors for the reconciliation platform.

These live in ``backend.recon_core`` (not the agent-blueprint container modules) so that code
packaged into the shared Lambda zip — e.g. ``auto_resolve`` and the harness worker — can import
them without depending on ``gateway_mcp`` (which ships only in the container image). The
container's ``gateway_mcp`` re-exports ``ToolDenied`` from here for backward compatibility.
"""


class ToolDenied(Exception):
    """Raised when a gateway tool invocation is denied by AgentCore Policy.

    The confidence gate lives in Cedar policy on the egress gateway: a call whose
    ``context.input.confidence`` is below the configured threshold is denied. Callers translate
    this into an escalation (the case stays PROPOSED for human review) rather than a failure.
    """

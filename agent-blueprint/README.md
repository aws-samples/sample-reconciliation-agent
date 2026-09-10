# `agent-blueprint/` — the two Tier-2 agent backends

The same reconciliation agent, implemented twice against different AgentCore primitives. The
agent-worker Lambda reads the selector from the SSM parameter named by `AGENT_BACKEND_PARAM`, which
the Config tab writes, so a switch needs no redeploy; the `agent_backend` Terraform variable
(`"runtime"` by default) only seeds the `AGENT_BACKEND` env that is used when that parameter is
unset or unreadable.

|                | `recon-agent/`                                 | `recon-agent-harness/`                          |
| -------------- | ---------------------------------------------- | ----------------------------------------------- |
| Primitive      | AgentCore **Runtime** — an arm64 container     | AgentCore **Harness** — a per-session microVM   |
| Built by       | CodeBuild, pushed to ECR                       | no container, no orchestration code             |
| Loop           | Strands `Agent` (`strands_investigator.py`)    | `backend/harness_agent/` drives the invoke loop |
| Classification | k-sample self-consistency, also a Strands call | harness-side                                    |

Both make gateway tool calls over MCP with SigV4, both return a JSON proposal, and **neither holds a
send tool**. The model writes a counterparty message into its proposal; a human approves a specific
revision of it.

`recon-agent-harness/README.md` covers the harness in detail, including the platform constraints it
rests on.

## Why two, and what that costs you

A/B-selectable backends are the point — but it means **an invariant has to hold in both, or a case
scores differently depending on which one ran it.** That is why evidence-completeness scoring lives
in `backend/recon_core/confidence.py` and is imported by both rather than reimplemented, and why
`tests/recon_core/test_confidence_idp.py` exists purely to assert the two agree.

When you add a rule, ask which side owns it. If the answer is "both", it belongs in
`backend/recon_core/`, not here.

## `recon-agent/skills/` — the classification catalog

The SKILL.md files **are** the classification-type registry. There is no DynamoDB lookup: the model
picks a name from this catalog, and a name that is not in it is recorded as `unknown` while
preserving the model's reasoning. There is deliberately **no confidence floor** — the model is never
asked how sure it is, and escalation is decided downstream by the computed evidence score
(`classifier.py`).

`metadata.tier` records what kind of skill a file is — `break-type`, `probe`, `resolution` or
`fallback` — and **nothing routes on it**. Tier-1 classifies with a plain-Python rule table
(`backend/tier1/classify.py`) that never reads this catalog, and its class reaches Tier-2 as an
advisory hint on the investigation prompt; a disagreement is logged and nothing more. The
classification recorded on the case is always the agent's own, and it selects only the skill whose
declared `evidence_steps` become the **denominator of the case's Evidence Score** — it does not
restrict which skills may run. `document-cross-reference` is one of three `probe` skills, and it
holds the sole channel to IDP-extracted document fields.

⚠️ **Six required evidence steps is a ceiling, not a style guide.** The score is
`satisfied_required / prescribed_required` and auto-resolve is gated on it, so a **seventh** required
step makes 6/7 = 0.857 clear a 0.85 threshold — auto-resolution on incomplete evidence, arrived at by
adding rigour. 5/6 = 0.833 does not. `tests/skills/` enforces this.

These files are **live-editable from the UI** and read from S3, so the catalog can change without a
deploy. That is also why there is deliberately no predicate DSL in the frontmatter: routing decisions
must not be expressible in a file an operator can edit.

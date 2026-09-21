# `agent-blueprint/` — the two Tier-2 agent backends

The same reconciliation agent, implemented twice against different AgentCore primitives. The selector
comes from the SSM parameter named by `AGENT_BACKEND_PARAM`, which the Config tab writes, so a switch
needs no redeploy; the `agent_backend` Terraform variable (`"runtime"` by default) only seeds the
`AGENT_BACKEND` env used when that parameter is unset or unreadable.

**Who reads it depends on the path.** On the primary path — the Tier-2 map run — `collect` resolves it
**once per run** and stamps it on every item, deliberately, so a run cannot straddle an operator's
mid-run switch with half its items going to each backend. The agent-worker reads it per invocation only
for the harness backend and the console's single-case retry.

|                | `recon-agent/`                                 | `recon-agent-harness/`                          |
| -------------- | ---------------------------------------------- | ----------------------------------------------- |
| Primitive      | AgentCore **Runtime** — an arm64 container     | AgentCore **Harness** — a per-session microVM   |
| Built by       | CodeBuild, pushed to ECR                       | no container, no orchestration code             |
| Loop           | Strands `Agent` (`strands_investigator.py`)    | `backend/harness_agent/` drives the invoke loop |
| Classification | k-sample self-consistency, also a Strands call | harness-side                                    |

### The container has TWO invocation modes

`recon-agent/agent.py` branches on whether a `taskToken` is present on the payload:

|                         | with `taskToken` (the map run)                                                           | without (console retry)                  |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Returns                 | `{"status": "accepted"}` in ~1s                                                          | the full result, after the investigation |
| Investigation           | backgrounded onto a **thread**, not a task (see below)                                   | inline                                   |
| Session kept alive by   | `HealthyBusy` on `/ping` — a session reporting `Healthy` is terminated after 15 min idle | the open request                         |
| Completion signalled by | the PLATFORM calling `SendTaskSuccess` / `SendTaskFailure`                               | the response body                        |
| Outer bound             | the 8-hour session lifetime (the caller's state gives up at 1800s first)                 | the caller's own timeout                 |

#### ⚠️ A thread, not `asyncio.create_task` — and not `@app.async_task`

Returning from the entrypoint is only **half** of releasing the caller. The SDK runs an async
entrypoint on a dedicated worker loop and awaits it with `run_coroutine_threadsafe`, so the HTTP
response does not complete until anything scheduled on that loop does. Measured 2026-09-11, a
`create_task` version logged `Async task completed (152.340s)` and then
`Invocation completed successfully (152.342s)` — **2 ms apart**. The caller blocked for the whole
investigation on _both_ transports, the dispatcher hit `Sandbox.Timedout`, and the retry produced a
second investigation of the same case.

The work therefore runs on a real `threading.Thread`, which the SDK is not waiting on. That rules out
the `@app.async_task` decorator too, since it only wraps a coroutine — so the busy status is
maintained by hand with `app.add_async_task()` / `app.complete_async_task()`, the SDK's API for
exactly this. That pairing is load-bearing, not bookkeeping: without the registration the container is
reclaimed mid-run, and without the completion the session stays busy until its 8-hour lifetime
expires. It is bracketed in a `finally` for that reason.

The callback is platform code, never a
model-callable tool — Cedar denies the agent role the status-transition tool for the same reason, so a
run cannot declare its own outcome.

The container also owns its own failure write: `_record_failure` marks the case `FAILED` when a run
dies, because it is the only party that can tell "I died" from "I am still working". The map run's
`Catch` covers the case where it died outright and nothing in it ran. Note this invariant is now
mirrored in `backend/tier1/agent_worker.py` too.

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

## `deal-pipeline-agent/` — the Deal Pipeline's knowledge, not a third backend

The console's second app has its own agent, and this directory is everything that agent _knows_:
four `skills/*/SKILL.md` (core parsing rules, two email-format skills, the staging-CSV contract) and
two prompts (`parser-system.md` for the parsing Lambda, `assistant-system.md` for the desk assistant
in the BFF). No code — the runtime is `backend/deal_pipeline/`. Terraform seeds all six to the
pipeline bucket, but with two different rules. The four skills and `parser-system.md` are
**create-only** seeds (`ignore_changes` in `infra/modules/deal-pipeline/main.tf`): from the first
apply on, the Skills tab and approved skill proposals own them in S3, and the repo file is the seed,
not the truth. `assistant-system.md` has no UI editor and **tracks the repo** — like the
`security-master/` CSVs and `samples/`, a change to the committed file re-uploads on the next apply,
and an edit made only in S3 is reverted by it. Frontmatter rules and the `metadata.applies_to`
filter the parser uses are in [`deal-pipeline-agent/README.md`](deal-pipeline-agent/README.md). It
runs its own Lambdas rather than either recon backend above, but reads its skills through the same
parser (`backend/recon_core/skill_meta.py`) and the same core helpers, so a SKILL.md means the same
thing to both agents.

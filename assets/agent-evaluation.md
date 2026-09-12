# Agent evaluation & optimization

> Detail page for the [Reconciliation Workflow Agent](../README.md).

The harness emits OTel traces, and a continuous evaluation pipeline scores them.

- **Online evaluation** (100% sampling, 4 evaluators): the `GoalSuccessRate`, `Helpfulness` and
  `Correctness` builtins, plus a custom analyst-agreement evaluator (a code-based Lambda scoring
  against the lessons ledger). Online eval scores each session about 5 min after it closes, which is
  before any analyst decision exists, so the agreement evaluator abstains at that point.

  The authoritative agreement pass is a batch re-score. Nothing schedules it weekly; it fires two
  ways. Every analyst decision triggers one automatically, so approving or correcting a case starts a
  targeted `StartBatchEvaluation` for that case's latest session with the agreement evaluator alone,
  and the metric updates within a few minutes with no manual step. The other way is the Evals-tab
  "Re-run evaluation" button, which re-scores the active backend's recent sessions against all
  evaluators.

- **Recommendations**: managed `SYSTEM_PROMPT_RECOMMENDATION` and
  `TOOL_DESCRIPTION_RECOMMENDATION` over a trace window. It is backend-agnostic, since the API
  distinguishes only the trace source, and the prompt sent for optimization is the shared policy core
  `s3://<assets>/system-prompt.md` that both backends run (see "One prompt, two backends" below).
  The harness's calling contract is deliberately kept out of what the optimizer sees, so an applied
  recommendation can never paraphrase the `submit_proposal` field list into the shared core.

- **Versioned config store**: `harness-configs/v<NNNN>.json` in S3 plus an SSM active-pointer. A
  deploy writes the version's `system_prompt` into the shared core object (`system-prompt.md`)
  first, then moves the pointer, and rollback is just deploying the older version. That order is
  what makes a deploy reach both backends: the runtime container reads the prompt object and never
  the pointer, so the prompt write _is_ the deploy and the pointer is the harness worker's view of
  it. A version with a blank `system_prompt` returns 409 instead of blanking the live prompt.

  A version's `system_prompt` is a snapshot at save time and is never rewritten, so it stays an
  honest record of what ran. The live prompt object, though, is also writable from the Skills tab
  (Skills → System Prompt), which does not move the pointer, so the deployed version can stop being
  the live text. The list endpoint compares the two and returns `liveMatchesDeployed`; when that is
  `false` the row reads **LIVE · edited since** and the panel explains that the edited text is what
  both backends run. `null`, meaning the prompt object could not be read, shows as `LIVE ?` and
  never as agreement.

  **Archive, not delete.** A bad version can be soft-archived out of the list
  (`PATCH /api/recon/harness/configs` `{version, archived}`), and "Show archived (n)" brings them
  back. There is no delete at all: the deployed version is both the rollback target and the drift
  baseline, and the documents are the record of every prompt that ever ran. Archiving the deployed
  version returns 409. Version numbering counts archived documents too, so a number is never reused.

Prerequisites: the harness backend active, and account-level CloudWatch Transaction Search enabled.

## Client → agent trace continuity

AgentCore traces the agent side for you, but the caller is a separate trace unless the client
propagates context. The SDK does not forward `traceparent` or `baggage`, so a worker invocation and
the agent's own spans land as two unrelated traces. The CALLER closes that gap with — read "caller" as the Tier-2 **dispatcher** on the map-run path, since it is what invokes the runtime now, and the agent-worker on the harness and console-retry paths; both carry the same ADOT layer and OTel env from the same `enable_worker_tracing` switch —
five pieces:

| Piece                                         | Where                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ADOT layer** `AWSOpenTelemetryDistroPython` | `enable_worker_tracing` / `otel_layer_version` (`infra/.../recon`)                                                  | supplies the `opentelemetry` packages + `/opt/otel-instrument` (`AWS_LAMBDA_EXEC_WRAPPER`). Deliberately **not** vendored into the shared Lambda zip, which every other Lambda uses.                                                                                                                                                                                                                   |
| **`backend/recon_core/otel_client.py`**       | dispatcher + worker + harness worker                                                                                | `traced(...)` custom spans around each invoke, `set_recon_baggage(...)` for item/domain/backend/session, `register_trace_propagation(client)`.                                                                                                                                                                                                                                                         |
| **boto3 `before-send` hook**                  | `register_trace_propagation`                                                                                        | injects `traceparent` + `baggage` (and forces `X-Amzn-Trace-Id` to `Sampled=1`) **after** SigV4, so the headers ride along unsigned and cannot invalidate the signature. The ingress path is hand-signed urllib with no botocore event system, so it takes the same headers through `invoke_via_ingress(extra_headers=…)`, merged after `signed_headers` — `ingress_invoke.py` itself stays OTel-free. |
| **`OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS`**        | set identically on **all three** participants: the worker Lambda, the harness definition, and the Runtime container | promotes the allow-listed baggage keys onto the agent-side spans — this is what makes `recon.item_id` / `session.id` searchable in Transaction Search. The allow-list is **per-participant**: the header propagates either way, but a participant without its own copy records nothing (the container runtime's spans showed only `session.id` until it got one).                                      |
| **Harness `environmentVariables`**            | `infra/modules/recon-agent-harness` (`HARNESS_ENV_JSON`)                                                            | span-noise reduction (`OTEL_PYTHON_EXCLUDED_URLS`, `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS`) plus the baggage allow-list; hashed into `config_hash` so an edit is never a no-op.                                                                                                                                                                                                                        |

Two settings are asymmetric on purpose. `AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT` and
`OTEL_SEMCONV_STABILITY_OPT_IN` are on for the Lambda, which emits no gen-ai content, and off for the
harness, because the live online evaluators score the gen-ai content records the harness emits;
opting out there would silently starve them.

Set `enable_worker_tracing = false` to detach the layer and make the whole client-side path inert. In
a private VPC the `xray` interface endpoint is required, and without it spans are dropped silently.

## One prompt, two backends

The agent's instructions live in one editable artifact, and both Tier-2 backends read it:

| Artifact                                 | Holds                                                                                   | Read by                                  | Written by                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `s3://<assets>/system-prompt.md`         | the shared **policy core** — role, skills-as-procedures, workflow, autonomy, principles | runtime container **and** harness worker | Skills-tab prompt editor; config-version deploy |
| `s3://<assets>/system-prompt-harness.md` | the harness's **calling contract** only — `submit_proposal` fields, prefixed tool names | harness worker (appended after the core) | repo seed, re-pushed by every apply             |

`backend/recon_core/prompt_source.py` owns the composition and fails loudly on an empty core.
Switching `agent_backend` therefore cannot change the agent's policy, only its calling mechanics.

One core object keeps the policy single-sourced, and the harness file holds only calling mechanics,
which cannot drift into policy.

Both S3 objects (and every `skills/<name>/SKILL.md`) are `ignore_changes` create-only
`aws_s3_object` seeds, so Terraform itself never overwrites live text — that is the prompt editor's
job. Keeping the repo and the live objects in step is instead
`aws_lambda_invocation.seed_push`, which runs on **every apply**: it re-pushes each entry of
`local.editable_seeds` whose repo file changed, and **fails the apply**, naming the key, when the
repo file _and_ the live object have both changed since the last push. A repo-side prompt or skill
edit therefore reaches an existing environment through a normal apply, with no manual `aws s3 cp`.
The one case it cannot see is an edit made **only** through the UI: that wins silently, because
there is nothing on the repo side to conflict with it.

# recon-agent-harness (AgentCore managed Harness blueprint)

A sibling to `agent-blueprint/recon-agent` that runs the same recon Tier-2 investigation on the
**AgentCore managed Harness** (config-declared agent; AgentCore runs the Strands loop in a
per-session microVM — no container, no orchestration code). A/B-selectable against the existing
container runtime via the `agent_backend` Terraform variable + the `AGENT_BACKEND` env on the
agent-worker Lambda.

See the harness-blueprint design record (kept outside this repository).

## Task 1 spike findings (2026-07-23, account `0264…8683` / profile `huthmac` / us-east-1)

Run `python infra/scripts/spike_harness.py` (safe, read-only) to reproduce.

| Question                                                                         | Finding                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness API in pinned botocore?                                                  | **Yes** — botocore **1.43.48** `bedrock-agentcore-control` has `CreateHarness`/`GetHarness`/`UpdateHarness`/`DeleteHarness`/`ListHarnesses` (+ endpoint/version ops); data-plane `bedrock-agentcore` has `InvokeHarness`. Terraform-first provisioning via `terraform_data` + boto3 `manage_harness.py` is viable (no AWS-CLI version dependence). |
| Harness endpoint available in us-east-1?                                         | **Yes** — `ListHarnesses` succeeds (0 existing). No beta-endpoint override needed.                                                                                                                                                                                                                                                                 |
| Sonnet 5 Bedrock model id?                                                       | Base `anthropic.claude-sonnet-5`; on-demand inference profiles `us.anthropic.claude-sonnet-5` and `global.anthropic.claude-sonnet-5`. **Use `us.anthropic.claude-sonnet-5`** (cross-region on-demand) as `harness_model_id`.                                                                                                                       |
| Exact IAM action for harness `awsIam` outbound → AWS_IAM-inbound egress gateway? | **`bedrock-agentcore:InvokeGateway`** on the gateway ARN (`arn:aws:bedrock-agentcore:<region>:<acct>:gateway/<id>`). Authorization is gateway-level, not per-target. Resolved during the ingress caller-switch (same action the Tier-1 worker now uses); confirmed against AWS docs (gateway-inbound-auth / resource-based-policies).              |

### Resolved during implementation (all three were open at Task 1)

The harness is implemented and deployed, so none of the Task-1 open questions are still open.
What they resolved to:

- **`inline_function` round-trip toolResult encoding** — the content part must be **`text`
  (a JSON string), NOT a bare `json` block**, even though `json` _is_ valid in the raw
  `InvokeHarness` toolResult schema. Strands sits one layer above the wire format and its
  `strands/models/bedrock.py:_format_request_message_content` has no mapping for a `json`
  content type, so it raises `TypeError: content_type=<json_> | unsupported type`. Encoded in
  `backend/harness_agent/worker.py` (`_toolresult_message`), with the reason recorded at the site.
- **Skill-source URI semantics** — **per-skill directory**, not a prefix: the skills list is
  built from comma-separated `s3://…/skills/<name>/` URIs
  (`infra/modules/recon-agent-harness/manage_harness.py:_skills`). Note the turn-budget
  consequence: skill loads consume turns under the agent-skills feature, so the harness max-turns
  default was raised 12 → 20 (`harness_config.py`).
- **Gateway client-context field names for write-tool provenance** — provenance is no longer a
  Lambda-side discriminator problem. It moved to the gateway **REQUEST interceptor**
  (`backend/gateway_interceptor/`), which checks the written reference against the persisted
  `proposed_action.reference`; the write Lambda keeps only the status allowlist. See
  the gateway trust-layer design record.

## A/B selector

`agent_backend` (root Terraform var, default `"runtime"`) → agent-worker Lambda env
`AGENT_BACKEND`. `agent_worker.py` selects: `"harness"` → `backend/harness_agent/worker.py`;
otherwise the existing runtime path (which itself chooses ingress-gateway vs. direct
`InvokeAgentRuntime`, with fallback — added by the ingress caller-switch). The two selectors are
orthogonal; flipping `agent_backend` is instant A/B + rollback.

## The model's tool surface is narrower than the gateway's

`harness_config.py` holds two lists and they are **not** interchangeable:

- **`GATEWAY_TOOLS`** — a _description_ of what the egress gateway exposes. Its only consumer is a
  naming comment in `backend/harness_agent/stream.py`. It enforces nothing.
- **`ALLOWED_TOOLS`** — the _enforced_ list, passed to `CreateHarness` as `allowedTools` by
  `manage_harness.py`. It is a strict subset: anything in `GATEWAY_TOOLS` but not here is never
  offered to the model.

The model gets four reads (`search_ledger`, `search_guidance`, `get_results`,
`search_correspondence`) and `submit_proposal`. Nothing it can call writes anything or leaves the
operator. Three things are withheld, for three different reasons:

- `set_draw_status` — a **policy** choice: the model is propose-only, and the worker executes the
  Policy-gated write after `intake.decide` says "execute". (It is absent from `GATEWAY_TOOLS` too.)
- `microsoft-graph___sendSharedMailboxMail` — a **design** choice, and the substance of the
  email-draft-approval change: the counterparty email is data the model writes into
  `submit_proposal`'s `email_draft`, and the send happens later from the BFF against the revision a
  human approved. See the `counterparty-contact-draft` bullet below.
- `microsoft-graph___listSharedMailboxMessages` — a **technical** blocker: the raw op is on the
  gateway, but **the schema the gateway advertises for it** can never be offered to a model (see
  the `correspondence-search` bullet below).

Both mailbox skills still run here. How each one relates to Graph is worth knowing:

- **`correspondence-search`** goes through `correspondence-search___search_correspondence`, a
  recon-owned Lambda target (`backend/correspondence_tool/handler.py`), **not** the raw
  `microsoft-graph___listSharedMailboxMessages`. That raw op is still excluded and always will be:
  the gateway advertises its OData query parameters as inputSchema _property names_ (`$top`,
  `$search`), which violate Bedrock's `^[a-zA-Z0-9_.-]{1,64}$` and crash `ConverseStream` the
  moment the tool is offered. The wrapper declares only pattern-legal `query`/`top`, assembles the
  OData form server-side, and re-enters the gateway to call the raw op itself — so the Graph
  credential stays in the token vault and the read still passes Cedar and the interceptor. The
  container runtime does the same translation in-process; this target is that wrapper, server-side.
  (The runtime registers its in-process wrapper under the raw op's own name as a tolerant-matching
  alias, so that name in a _runtime_ tool list is the clean `query`/`top` wrapper — not the raw
  schema, which is unofferable on either backend.)
- **`counterparty-contact-draft`** calls no tool at all (`tools: []`). It tells the model to put the
  message in `submit_proposal`'s `email_draft` and stop. The send op is pattern-compliant and would
  work if offered — its exclusion is not technical. An earlier release did offer it, relying on the
  gateway REQUEST interceptor's confirmation gate to deny every model-originated send (the model
  cannot obtain `EMAIL_CONFIRMATION_TOKEN`; only the platform send paths hold it). That was safe but
  wrong-shaped: it put a send affordance in front of a model whose every send was destined to be
  refused, and each refusal landed on the case trace looking like an attempted outbound email. Now
  the draft is persisted on the case, an analyst approves a specific revision, and the BFF sends
  that exact text — the interceptor still gates the send, but it now checks **provenance** (does
  this message equal the draft a human approved on this case?) rather than only **capability** (does
  the caller hold the token?). Both backends behave identically: the agent drafts, a human sends.

Mistaking `GATEWAY_TOOLS` for the allowlist once made two harness runs look like model
tool-selection behaviour when the tools were simply never on offer. Two tests in
`tests/harness_agent/test_harness_config.py` pin both the subset relationship and the rule that the
system prompt may never name a tool `ALLOWED_TOOLS` filters out. Background:
the Graph read-argument normalization design (how the exclusions were diagnosed)
and the harness signal + tool-parity design (fixes 3 and 4, which made both
mailbox skills reachable on this backend — live-verified on `recon-dev` 2026-08-08).

## This blueprint's `system-prompt.md` is the calling contract only

Since the shared-system-prompt change,
the agent's **policy** — role, skills-as-procedures, workflow, autonomy, principles — lives in
exactly one editable artifact that **both** backends read: `s3://<assets>/system-prompt.md`.
The file in this directory seeds `s3://<assets>/system-prompt-harness.md`, which holds **only**
the harness's calling contract (the `submit_proposal` field list and prefixed tool names) and is
appended after the shared core by `backend/recon_core/prompt_source.py`.

Two consequences:

- **Do not restate policy here.** It would drift from the runtime's copy — which is exactly the
  failure the shared-core change fixed. `prompt_source.py` fails loudly on an empty core.
- **The S3 seed is create-only** (`ignore_changes`), so editing this file does not update the live
  object. Push it with `aws s3 cp` to `s3://<assets>/system-prompt-harness.md`.

The contract is also deliberately excluded from what the prompt optimizer sees, so an applied
recommendation can never paraphrase the `submit_proposal` field list into the shared core.

## AgentCore-CLI dev loop (optional)

Terraform (`manage_harness.py`) is the source of truth for the deployed harness. For rapid local
iteration on the system prompt / tools, the AgentCore CLI can create a scratch harness — but do
not point production traffic at a CLI-managed harness; re-apply Terraform to converge.

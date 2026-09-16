# `backend/` — Python packages

Every Lambda and every shared library the platform runs. There is no framework here and no
dependency-injection container: a package is either a **Lambda entry point** (it has `handler.py`)
or a **library** other packages import.

One deliberate exception: `tier2_dispatch/` ships THREE entry points (`handler.py`, `collect.py`,
`case_step.py`). They are three steps of one state machine and share its table bindings, so splitting
them into three packages would buy nothing but a third copy of the same wiring.

Which one a directory is decides how you change it. A Lambda's contract is its event shape and it
is deployed by the module of the same name under `infra/modules/`; a library's contract is its
function signatures and it ships inside whichever Lambda zips it.

`deal_pipeline/` is the one exception to the `handler.py` rule: it is a library **and** two entry
points (`parser_handler.py`, `oms_upload_handler.py`), both deployed by `infra/modules/deal-pipeline`
from the one zip the recon root builds for every Lambda it deploys (`module.lambda_package` in
`infra/environments/recon/main.tf`). Any file in `backend/` redeploys both.

## Libraries

| Package          | What it owns                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recon_core/`    | The domain. Schemas, the notice store, evidence-completeness scoring, email policy, proposal assembly. The **only** place a reconciliation rule should live. Also the plumbing both apps share: `memory` (AgentCore Memory recall), `model_select` (the SSM model-id read with its allowlist), `ddb_update` (`UpdateItem` helpers), `s3_text` (optional-object reads) and `skill_meta` (the SKILL.md frontmatter parser and the cached S3 catalog read). |
| `cases/`         | Case lifecycle transitions and the resolution notification.                                                                                                  |
| `harness_agent/` | The harness backend's invoke loop and stream→trace assembly. Its sibling is `agent-blueprint/recon-agent/`, the container backend.                           |
| `deal_pipeline/` | The Deal Pipeline app, library and Lambdas in one package: `oms_schema` + `oms_fields.json` (the staging-CSV contract, mirrored in the frontend and asserted equal), `oms_validator` (one stable error code per rule), `security_master`, `skills_loader`, `memory_recall`, `coerce`, and the `agent` tool loop. Its plumbing comes from `recon_core/` — `memory.retrieve_records`, `model_select.get_agent_model_id`, `ddb_update`, `s3_text.read_text` and `skill_meta.read_s3_skills`, the SKILL.md parser both apps share (the pipeline passes `name_fallback="directory"` and `ttl_seconds=0`; recon passes neither, and its behaviour is the default). The pipeline Lambdas run from the recon root's zip, whose `runtime_dependencies` already vendor pydantic and PyYAML, so a `recon_core` import that needs either is fine here. |

## Lambdas

| Package                       | Triggered by                           | What it does                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `intake/`                     | API Gateway                            | Validates a dataset and persists `ReconItem`s. Deliberately no normalisation.                                                                                                                                                                                |
| `tier1/`                      | `recon-items` DynamoDB stream          | Deterministic triage: reconcile the item, or open a `PENDING` case for Tier-2. It **dispatches nothing** — a fan-out from a stream shard cannot be bounded. Also holds the BLOCKING agent-worker, still used by the harness backend and the console's retry. |
| `tier2_dispatch/`             | Step Functions (`recon-dev-tier2`)     | The map run's three steps: `collect` (PENDING → S3, backend resolved once per run, single-flight guarded), `handler` (the dispatcher — hands the runtime a task token and returns in ~1s), and `case_step` (the guarded claim / mark-failed writes).         |
| `idp_hook/`                   | IDP Step Functions **terminal** status | Maps an extracted document to a **notice**, or writes a tracking-only row when it cannot. Also copies page previews into the assets bucket. Never a case.                                                                                                    |
| `gl_tool/`                    | Gateway                                | `search_ledger` — Athena over the GL data in S3. The **expected** side.                                                                                                                                                                                      |
| `notice_tool/`                | Gateway                                | `search_notices` — the **actual** side.                                                                                                                                                                                                                      |
| `correspondence_tool/`        | Gateway                                | `search_correspondence` — a mailbox search shaped so the model can call it.                                                                                                                                                                                  |
| `contacts/`                   | Gateway                                | `list_contacts` / `list_templates`, projected **without addresses**.                                                                                                                                                                                         |
| `status_tool/`                | Gateway                                | `recon_update_status` — the single guarded write path for lifecycle transitions.                                                                                                                                                                             |
| `gateway_interceptor/`        | Gateway REQUEST hook                   | The trust boundary for write-class tools. Not a tool; it inspects calls.                                                                                                                                                                                     |
| `eval_agreement/`             | AgentCore Evaluations                  | Custom evaluator scoring sessions against analyst ground truth.                                                                                                                                                                                              |
| `email_preprocess/`           | BFF upload route                       | Turns an uploaded email into forwardable documents.                                                                                                                                                                                                          |
| `kb_ingest/`                  | Assets-bucket put                      | Debounced, serialized knowledge-base ingestion.                                                                                                                                                                                                              |
| `skills_api/`, `lessons_api/` | API Gateway                            | Read-only BFFs for the Skills and Lessons tabs.                                                                                                                                                                                                              |
| `deal_pipeline/parser_handler`     | Pipeline BFF (async)                   | Parses one deal email with a Bedrock Converse tool loop and stages a deal + CSV.                                                                                                                                                                             |
| `deal_pipeline/oms_upload_handler` | Pipeline BFF (sync)                    | The mock OMS: validates a staging CSV and returns `{accepted, errors[]}`.                                                                                                                                                                                     |

## Two things that will bite you

**The notice table has no DynamoDB stream, and that is deliberate.** An extracted document is
evidence _about_ a reconciliation item, never the thing that creates or advances one. `idp_hook`
therefore writes a notice and stops — there is no path from extraction to a case. Adding a stream
would create one silently.

**"Searched, found nothing" and "the read failed" are different answers everywhere.** A tool
returns an empty result set for the first and _raises_ for the second. Collapsing them makes a
broken query look to the agent like a counterparty that does not exist, which is the failure mode
none of the tests would catch for you.

## Working here

Tests live in `tests/<package>/`, never beside the code — see [`../tests/README.md`](../tests/README.md).

```bash
python3 -m pytest tests/ -q          # whole suite
python3 -m ruff check backend/       # lint
```

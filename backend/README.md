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

## Libraries

| Package          | What it owns                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recon_core/`    | The domain. Schemas, the notice store, evidence-completeness scoring, email policy, proposal assembly. The **only** place a reconciliation rule should live. |
| `cases/`         | Case lifecycle transitions and the resolution notification.                                                                                                  |
| `harness_agent/` | The harness backend's invoke loop and stream→trace assembly. Its sibling is `agent-blueprint/recon-agent/`, the container backend.                           |

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

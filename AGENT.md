# AGENT.md — working in this repo

For coding agents and anyone new. [`README.md`](README.md) explains **what the platform is**; this
explains **how to change it without breaking something silently**. Everything here was learned the
hard way; none of it is inferable from reading the code.

## Layout

| Path                    | Guide                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `backend/`              | [Python Lambdas + libraries](backend/README.md) — recon packages plus `deal_pipeline/`                                        |
| `agent-blueprint/`      | [the two Tier-2 agent backends](agent-blueprint/README.md), plus the Deal Pipeline's skills and prompts                        |
| `infra/`                | [Terraform](infra/README.md) — the console's root is `infra/environments/recon`; `environments/deal-pipeline` runs the pipeline alone |
| `tests/`                | [the Python suite](tests/README.md) — never beside the code                                                                   |
| `scripts/`              | [generators + live-deployment tooling](scripts/README.md)                                                                     |
| `data/`                 | [fixtures and the guidance corpus](data/README.md) — recon's notices and ledger, the pipeline's emails and security master     |
| `docs/`                 | [`deal-pipeline-design.md`](docs/deal-pipeline-design.md), the Deal Pipeline contract — the one design doc that is tracked    |
| `chatbot-app/frontend/` | Next.js shell + two apps (`/recon`, `/pipeline`) + their BFFs; tests in `__tests__/`, run with `npx vitest run`               |

## Commands that are actually the gate

```bash
python3 -m pytest tests/ -q                  # 1416 passed, 15 skipped, ~35s
python3 -m ruff check backend/ tests/        # lint
cd chatbot-app/frontend && npx vitest run    # 62 files, 874 tests
cd chatbot-app/frontend && npx tsc --noEmit  # typecheck
cd infra/environments/recon && terraform fmt -check -recursive ../..
```

Three traps:

- **`terraform validate` from `infra/` passes vacuously.** There is no configuration at that level.
  Run it from `infra/environments/recon`.
- **Repo-wide ESLint is broken.** Use `prettier` + `tsc --noEmit`; CI's `frontend` job is the real gate.
- **`ruff format` drift is pre-existing in 34 files.** Don't reformat them as a side effect — check
  whether a file was already drifting at `HEAD` before "fixing" it.

Every count above is a snapshot measured at `HEAD`, and **nothing asserts any of them.** They have
drifted apart three ways before (this file, `README.md` and `.gitlab-ci.yml` each quoted a different
number). Re-measure before you quote one, and read a disagreement as a stale line rather than as a
missing test.

## The one design rule everything else follows

**This platform prefers reporting "unavailable" over failing.** A field the source never carried, a
field extraction missed, and a field that came back blank are three different states, and collapsing
them loses information the agent acts on.

The consequence for you: **a wrong value and a missing one look identical downstream.** Nothing
reports the difference. So —

- Omit a key entirely for "not applicable to this class". Emit `""` for "the document says nothing
  here". Never emit a placeholder, a zero or a dash.
- `"searched, found nothing"` returns an empty result; **a read failure raises.** Conflating them
  makes a broken query look like a counterparty that does not exist.
- Never add a silent fallback or a default to keep code running. Raise.

## Two apps, one console

Since 2026-09-11 the frontend is a shell hosting two applications side by side: Trade Reconciliation
(`/recon`, `/api/recon`) and Deal Pipeline (`/pipeline`, `/api/pipeline`). The shell is a landing
chooser at `/`, a collapsible app rail, `/api/me`, and one access check. Read these before touching
either app's edges:

| File                                                | Owns                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatbot-app/frontend/src/lib/auth/apps.ts`         | The app registry: `APPS`, `Viewer`, `resolveAppAccess`, `allConfiguredGroups`, `appForApiPath` / `appForPagePath`. Adding an app is one entry here plus its route trees |
| `chatbot-app/frontend/src/lib/api-auth.ts`          | Token verification, the groups claim, anonymous mode (`ALLOW_ANONYMOUS_API`, `ANONYMOUS_GROUPS`)                                                                        |
| `chatbot-app/frontend/src/proxy.ts`                 | The deny-by-default gate: every `/api/recon/*` and `/api/pipeline/*` request is verified and matched against that app's access group before a handler runs               |
| `src/lib/reconAdmin.ts`, `src/lib/pipelineAdmin.ts` | The admin re-check inside each app's write routes — the rail hiding a button is not the gate                                                                            |
| `src/lib/pipeline/server/env.ts`                    | Every environment name the pipeline BFF reads                                                                                                                            |
| `docs/deal-pipeline-design.md`                      | The pipeline's data model, OMS rules, routes, environment and demo script; §13 is the console integration                                                               |

Rules that follow:

- **The two apps stay decoupled.** Nothing under `src/{app,components,lib,hooks}` that is recon's
  imports from the pipeline's tree, or the reverse. The shared surface is the auth module
  (`src/lib/auth/`, `src/lib/api-auth.ts`, `src/lib/reauth.ts`, the auth wrappers), the `src/components/ui/`
  primitives, and app-agnostic helpers with no app state (`columnPrefs`, `skillFrontmatter`). A
  feature both apps need goes into one of those, never into one app for the other to reach into.
- **Access groups: unset access = open, unset admin = closed.** `RECON_ACCESS_GROUP` /
  `PIPELINE_ACCESS_GROUP` unset keeps that app open to every authenticated user (what every
  deployment had before the shell). `RECON_ADMIN_GROUP` / `PIPELINE_ADMIN_GROUP` unset means nobody
  can change that app. Do not "fix" either direction.
- **In the composed container, always set the `PIPELINE_`-prefixed names.** The pipeline BFF reads
  `PIPELINE_ASSETS_BUCKET ?? ASSETS_BUCKET`, `PIPELINE_AGENT_MODEL_PARAM ?? AGENT_MODEL_PARAM`,
  `PIPELINE_SKILLS_PREFIX ?? SKILLS_PREFIX`. The bare fallbacks exist for the standalone root's
  `.env.local`; in the console's task the bare names are recon's and all three exist, so a missing
  prefixed name reads recon's bucket, model parameter or skills with no error at all. The Lambdas
  keep bare names — they are separate processes.
- **Sample emails come from disk when `data/deal-emails` exists and from S3 (`PIPELINE_SAMPLES_PREFIX`,
  default `samples/`) when it does not.** The container ships no `data/`, so Terraform seeds the corpus
  to the pipeline bucket; a new sample file needs an apply before the console shows it. Ids are the
  file name without `.json` in both sources.

## Git workflow

Worktrees per feature, at `<repo-root>/.worktrees/<branch-name>/` — a `PreToolUse` hook rejects any
other target. Never implement on `main`.

**Ship path is push → MR → green pipeline → merge the MR.** The merge _is_ the deploy trigger; a
local merge to `main` means no pipeline ever runs and nothing is applied, so the work looks shipped
and isn't.

⚠️ `docs/` holds exactly one tracked file, `docs/deal-pipeline-design.md`, because it is the
contract the pipeline's code and tests are written against. Everything else that used to live there —
plans, design records, audit reports — stays untracked working notes: don't add a second file without
the same justification, and don't cite an untracked `docs/` path from tracked code, because it
resolves to nothing in a clone.

## Deploys

CI owns `terraform apply`. It reconstructs `terraform.tfvars` from the protected `RECON_TFVARS` CI
variable and **does not read your working copy** — so editing the local file alone changes nothing,
and the next pipeline reverts whatever a local apply did.

The plain apply job fails on deletions by design; `terraform:apply:allow-destroy` is the manual
escape hatch. Read the plan before using it: the guard exists for the case where a truncated
`RECON_TFVARS` silently plans the Graph integration for destruction.

⚠️ **`*.tfplan` files are secret-bearing.** A binary plan stores every variable value in the clear,
including the ones declared `sensitive = true` — which is why CI archives only the redacted
`recon.plan.txt`. They are gitignored, so nothing stops one sitting in your checkout for weeks.
Delete them when you are done with them.

## What the repo cannot tell you

Four controls are set outside the tracked tree (protected `RECON_TFVARS`, or SSM at runtime), so a
local file is not evidence of what is live. Read them off the resource:

```bash
aws lambda get-function-configuration --function-name recon-dev-gw-interceptor \
  --query 'Environment.Variables.INTERCEPTOR_MODE'          # 'log' NEVER blocks
aws ssm get-parameter --name /recon-dev/agent-backend        # which backend you are debugging
aws ssm get-parameter --name /recon-dev/auto-resolve-threshold  # unreadable = human review
aws ssm get-parameter --name /recon-dev/tier1-enabled
```

The interceptor one matters most: it is the only place the provenance, evidence-quality and
case-transition guards are enforced, and in `log` mode all three degrade to observation while every
call still succeeds. Verified `enforce` on `recon-dev` on 2026-09-07.

## Where the real invariants live

Don't restate a rule in a second place — these are the single owners:

| Rule                                     | Owner                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Evidence-completeness scoring            | `backend/recon_core/confidence.py` (both agent backends import it)                       |
| The notice model and its store           | `backend/recon_core/notices.py`                                                          |
| Who the platform may email               | `recon-contacts` via the Config tab, and nowhere else                                    |
| Whether a counterparty send is permitted | the gateway REQUEST interceptor, and nowhere else                                        |
| What extraction must emit                | `data/input/IDP-EXTRACTION-REQUIREMENTS.md`, asserted both ways by `tests/input_corpus/` |
| The classification catalog               | `agent-blueprint/recon-agent/skills/*.md`                                                |
| Which app owns a path, and who may use it | `chatbot-app/frontend/src/lib/auth/apps.ts`                                              |
| The OMS staging-CSV schema               | `backend/deal_pipeline/oms_fields.json` (the frontend mirror is asserted equal by a test)  |
| The mock OMS validation rules            | `backend/deal_pipeline/oms_validator.py`, one stable `code` per rule                      |
| The pipeline's environment names         | `chatbot-app/frontend/src/lib/pipeline/server/env.ts`                                    |

The email-domain allowlist is the cautionary tale: it was once read in four places, and the three
non-authoritative copies each read a container env var fixed at task start. A narrowed allowlist was
enforced by the interceptor while the UI still displayed the old one, and an out-of-domain contact
saved successfully but showed an amber warning that read as a failed save. **A control mirrored in
four places is a control that lies.**

## Names and language

- Systems are named by **generic role**, never by vendor or product — `tests/skills/` enforces the
  scrub. The corpus is published; a named system dates it and implies an endorsement.
- Every email address in `data/` must sit in an RFC 2606 / 6761 reserved domain
  (`.example`, `.example.com/.net/.org`). Secret scanners do not flag addresses, so these tests are
  the only defence, and all three of `data/input/`, `data/kb-seed/` and the rest of `data/` are
  swept. A tenant domain is the one exception, written as Microsoft's documentation placeholder
  `contoso.onmicrosoft.com`; the real one belongs in the gitignored tfvars and nowhere else.
- This is the first release. Nothing is "legacy", and there are no design-record or `§`-section
  references to a document outside the repo. If a comment needs a rule, state the rule.

# AGENT.md — working in this repo

For coding agents and anyone new. [`README.md`](README.md) explains **what the platform is**; this
explains **how to change it without breaking something silently**. Everything here was learned the
hard way; none of it is inferable from reading the code.

## Layout

| Path                    | Guide                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `backend/`              | [Python Lambdas + libraries](backend/README.md) — recon packages plus `deal_pipeline/`                                        |
| `agent-blueprint/`      | [the two Tier-2 agent backends](agent-blueprint/README.md), plus the Deal Pipeline's skills and prompts                        |
| `infra/`                | [Terraform](infra/README.md) — one root, `infra/environments/recon`; `enable_deal_pipeline` composes the pipeline into it |
| `tests/`                | [the Python suite](tests/README.md) — never beside the code                                                                   |
| `scripts/`              | [generators + live-deployment tooling](scripts/README.md)                                                                     |
| `data/`                 | [fixtures and the guidance corpus](data/README.md) — recon's notices and ledger, the pipeline's emails and security master     |
| `docs/`                 | [`deal-pipeline-design.md`](docs/deal-pipeline-design.md), the Deal Pipeline contract — the one design doc that is tracked    |
| `chatbot-app/frontend/` | Next.js shell + two apps (`/recon`, `/pipeline`) + their BFFs; tests in `__tests__/`, run with `npx vitest run`               |

## Commands that are actually the gate

```bash
python3 -m pytest tests/ -q                  # 1874 passed, 21 skipped, ~50s
python3 -m ruff check backend/ tests/        # lint
cd chatbot-app/frontend && npx vitest run    # 124 files, 1711 tests
cd chatbot-app/frontend && npx tsc --noEmit  # typecheck
cd infra/environments/recon && terraform fmt -check -recursive ../..
# Module tests: plan-only under mocked providers, no credentials. Both CIs run them, and they are
# the only check that notices a renamed PIPELINE_* variable or a missing task-role grant.
for tests in infra/modules/*/tests; do
  (cd "$(dirname "$tests")" && terraform init -backend=false && terraform test)
done
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
| `chatbot-app/frontend/src/lib/auth/apps.ts`         | The app registry: `APPS`, `Viewer`, `resolveAppAccess`, `adminGroupFor` / `accessGroupFor`, `allConfiguredGroups`, `appForApiPath` / `appForPagePath`. Adding an app is one entry here plus its route trees; the pipeline entry also names `PIPELINE_ENABLED` as its `enabledEnv` |
| `chatbot-app/frontend/src/lib/console/types.ts`     | The console-wide configuration contract: the SSM layout under `CONSOLE_SETTINGS_PREFIX`, the stored → env → default resolution as an overlay on the names `apps.ts` reads, the `/api/console/*` route shapes, the env-only switches (`REQUIRE_ACCESS_GROUPS`, `ALLOW_ANONYMOUS_API` and its two pre-shell names, `CONSOLE_ADMIN_GROUP`) and the validation limits. §14 of the design doc is the prose |
| `chatbot-app/frontend/src/lib/api-auth.ts`          | Token verification, the groups claim, anonymous mode — three switch names mean the same thing (`ALLOW_ANONYMOUS_API`, plus the pre-shell `RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API`), narrowed by `ANONYMOUS_GROUPS` |
| `chatbot-app/frontend/src/proxy.ts`                 | The deny-by-default gate: every `/api/recon/*` and `/api/pipeline/*` request is verified and matched against that app's access group before a handler runs; a disabled app's BFF is a 403 |
| `src/lib/auth/app-admin.ts` (`reconAdmin.ts` is recon's named binding) | The admin re-check inside the write routes that carry one — every pipeline write, but only part of recon's (see the access-groups rule below). The rail hiding a button is not the gate |
| `src/lib/pipeline/server/env.ts`                    | Every environment name the pipeline BFF reads                                                                                                                            |
| `docs/deal-pipeline-design.md`                      | The pipeline's data model, OMS rules, routes, environment and demo script; §13 is the console integration                                                               |

Rules that follow:

- **The two apps stay decoupled.** Nothing under `src/{app,components,lib,hooks}` that is recon's
  imports from the pipeline's tree, or the reverse. The shared surface is the identity spine
  (`src/lib/auth/`: the registry, `client-token.ts`, `authed-fetch.ts` behind every BFF client,
  `app-admin.ts` behind every admin-gated write; `src/lib/api-auth.ts`, `src/lib/reauth.ts`, the auth
  wrappers; `src/hooks/useAppSubject.ts` over the shell's `/api/me` store), the instrument theme
  (`src/app/app-theme.css`) with the chrome and primitives built on it (`src/components/app-ui/`), the
  `src/components/ui/` primitives, and app-agnostic helpers with no app state (`src/lib/server/` —
  HTTP envelope, memory request parsing, the model allowlist, `ssm.ts`, `memoryClient.ts` and
  `skillsStore.ts`, each a factory the app parameterises with its own ids, bucket and options whose
  defaults are recon's behaviour; `src/lib/api/client.ts`; `src/lib/models/presets.ts`;
  `src/lib/memoryStrategy.ts`; `columnPrefs`, whose storage keys carry the app id; `skillFrontmatter`,
  whose `validateSkill` refuses what the Lambdas' YAML parser would misread). The shared panels those
  factories feed (`ModelSelectPanel`, `MemoryPanel`, `SkillsCatalog`, `SkillEditor`,
  `PromptEditorPage`) live in `src/components/app-ui/` and take recon's presentation as their defaults.
  A feature both apps need goes into one of those, never into one app for the other to reach into.
  Never an `if (app === ...)` branch: a difference between the apps is an explicit option.

  On the Python side the same rule holds for `backend/recon_core/`: `deal_pipeline` imports it
  (memory retrieval, model selection, DynamoDB update helpers, S3 text reads, the SKILL.md parser
  with its `name_fallback` and `ttl_seconds` options) and adds nothing recon-specific to it.
- **Access groups: unset access = open, unset admin = closed — until `REQUIRE_ACCESS_GROUPS`.**
  `RECON_ACCESS_GROUP` / `PIPELINE_ACCESS_GROUP` unset keeps that app open to every authenticated
  user (what a recon-only deployment had before the shell). `REQUIRE_ACCESS_GROUPS=true` (exact
  string) flips that to fail closed: an app whose access group is blank is then denied to everyone
  but its admins. The composed ECS deployment sets it whenever the pipeline is enabled, and the recon
  root refuses to plan `enable_deal_pipeline = true` with either access group blank — because the
  moment two populations share one OIDC client, "every authenticated user" stops meaning "a recon
  analyst". `RECON_ADMIN_GROUP` / `PIPELINE_ADMIN_GROUP` unset means nobody can change that app. Do
  not "fix" either direction.
- **`RECON_ACCESS_GROUP` is recon's real write boundary, not `RECON_ADMIN_GROUP`.** Every pipeline
  write route re-checks the admin group. Recon's admin group gates only `config/*` (threshold,
  backend, Tier-1, contacts, templates, workflow-types), `memory` DELETE and `uploads`; the
  case-decision routes (`cases/[id]`, its `draft`) verify the actor. The rest of recon's writes —
  `system-prompt`, `skills`, `harness/configs` (+ `deploy`), `evals/batch`,
  `evals/recommendations`, `idp-extractions`, bulk `cases` POST — are open to anyone the proxy
  admits, so whoever holds recon access can rewrite the Tier-2 agent's prompt and skills. Name the
  group before you widen who signs in.
- **Per-app configuration never moves into the console layer without a decision.** The layer under
  `CONSOLE_SETTINGS_PREFIX` (`src/lib/console/types.ts`) holds what applies to the console as a whole:
  each app's access and admin group, app enablement, defaults an app may _inherit_, and per-user
  preferences. Thresholds, backend, Tier-1, contacts, templates, workflow types and the parser model
  stay in each app's Config tab and its own parameters; the recon Config tab does not change. An app
  may COPY a console default into its own parameter (the pipeline Config tab's "Use console default"
  is a normal PUT of `PIPELINE_AGENT_MODEL_PARAM`; the parser keeps reading that parameter alone), but
  the console layer never writes an app's parameter and no app follows a console value live. Moving a
  setting up is recorded in §14 of the design doc first — it is not a refactor.
- **Stored settings overlay the env names; three names never enter the overlay.** A non-blank value
  under the prefix replaces `RECON_ACCESS_GROUP`, `RECON_ADMIN_GROUP`, `PIPELINE_ACCESS_GROUP`,
  `PIPELINE_ADMIN_GROUP` or `PIPELINE_ENABLED` before `resolveAppAccess` reads it, and clearing it
  falls back to env — never to open. `REQUIRE_ACCESS_GROUPS`, `ALLOW_ANONYMOUS_API` (and its two
  pre-shell names) and `CONSOLE_ADMIN_GROUP` are environment-only so that no UI edit can widen access
  past the deployment or make anyone a console admin. Do not add a stored form of any of them. Know
  the failure policy before relying on a stored-only restriction: when Parameter Store cannot be
  read, `effectiveEnv()` resolves from the environment alone for one 30 s window (logged once), so a
  group that exists only in the stored layer is unenforced for that window — name it in the
  environment too when that is unacceptable.
- **`PIPELINE_ENABLED=false` (exact string) switches the pipeline app off** in the running console:
  `resolveAppAccess` reports no access, `/api/me` hides it and the proxy 403s `/api/pipeline/*`.
  Unset or anything else is enabled, so local dev needs no extra variable; the ECS task sets it from
  `pipeline_enabled`. Recon has no such switch — it is always on.
- **The pipeline BFF reads only the `PIPELINE_`-prefixed names.** `PIPELINE_ASSETS_BUCKET` and
  `PIPELINE_AGENT_MODEL_PARAM` are required, `PIPELINE_SKILLS_PREFIX` defaults to `skills/`, and
  there is no fallback to `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` or `SKILLS_PREFIX`: in the console's
  task those bare names are recon's and all three exist, so a fallback would have read recon's
  bucket, model parameter or skills with no error at all. The recon root's `frontend_env_local` output
  renders the prefixed names too. The Lambdas keep bare names — they are separate processes.
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
contract the pipeline's code and tests are written against. `.gitignore` enforces the rest with
`docs/*` plus a negation for that one file, so plans, design records and audit reports dropped into
`docs/` stay untracked working notes even under `git add -A`. Tracking a second file means adding a
second negation with the same justification — and never cite an untracked `docs/` path from tracked
code, because it resolves to nothing in a clone.

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

Seven controls are set outside the tracked tree (protected `RECON_TFVARS`, SSM at runtime, or on the
resource itself), so a local file is not evidence of what is live. Read them off the resource:

```bash
aws lambda get-function-configuration --function-name recon-dev-gw-interceptor \
  --query 'Environment.Variables.INTERCEPTOR_MODE'          # 'log' NEVER blocks
aws ssm get-parameter --name /recon-dev/agent-backend        # which backend you are debugging
aws ssm get-parameter --name /recon-dev/auto-resolve-threshold  # unreadable = human review
aws ssm get-parameter --name /recon-dev/tier1-enabled

# Whether Tier-2 runs AT ALL. The stream consumer dispatches nothing, so a disabled rule means
# escalated cases accumulate in PENDING forever and nothing looks broken.
aws events describe-rule --name recon-dev-tier2-schedule --query '[State,ScheduleExpression]'
# The Bedrock token budget, as the Map's MaxConcurrency. Grep the definition, not the variable file.
aws stepfunctions describe-state-machine \
  --state-machine-arn arn:aws:states:us-east-1:<account>:stateMachine:recon-dev-tier2 \
  --query 'definition' | grep -o '"MaxConcurrency":[0-9]*'

aws ssm get-parameters-by-path --path /recon-dev/console --recursive  # stored console settings that
                                                             # OVERLAY the task's group names
```

The last one is the console layer (§14 of the design doc): a group name or `PIPELINE_ENABLED` in the
task definition is only the fallback, and a value stored under `CONSOLE_SETTINGS_PREFIX` wins. The
Settings screen shows which is in force (`stored` / `env` / `default` chips); so does this command.

The interceptor one matters most: it is the only place the provenance, evidence-quality and
case-transition guards are enforced, and in `log` mode all three degrade to observation while every
call still succeeds. Confirm it reads `enforce` before you trust any of the three.

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
| The console-wide settings layout and resolution order | `chatbot-app/frontend/src/lib/console/types.ts`                              |
| The OMS staging-CSV schema               | `backend/deal_pipeline/oms_fields.json` (the frontend mirror is asserted equal by a test)  |
| The mock OMS validation rules            | `backend/deal_pipeline/oms_validator.py`, one stable `code` per rule                      |
| The pipeline's environment names         | `chatbot-app/frontend/src/lib/pipeline/server/env.ts`                                    |

The email-domain allowlist is the cautionary tale. Read it in four places — three of them a
container env var fixed at task start — and narrowing it puts the interceptor on the new list while
the UI still displays the wider one: an out-of-domain contact then saves successfully and shows an
amber warning that reads as a failed save. **A control mirrored in four places is a control that
lies.**

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

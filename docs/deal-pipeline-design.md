# Deal Pipeline demo — design

A Bedrock AgentCore demo that turns new-issue deal emails into staging CSVs for an order
management system (OMS), with a human review step and a two-tier learning loop (skills for
universal rules, AgentCore Memory for situational edge cases). This document is the contract
every part of the branch builds against. Names of the firm, its people and its vendors are
deliberately generic: "the firm", "the OMS", "the security master", "market news alerts".

## 1. Flow

```
Deal email ──► Inbox (simulated trigger) ──► Parsing agent (Lambda, Bedrock Converse tool loop)
                                                 │  reads skills (S3) + recalls edge-case memories
                                                 │  enriches from security master (S3 CSV)
                                                 ▼
                                      Deal record (DynamoDB) + staging CSV (S3)
                                                 │
                                      Deal Review & Approval (UI) ── edit fields ──┐
                                                 │ approve                          │
                                                 ▼                                  │
                                      Mock OMS upload (Lambda validator) ── accepted ► oms-staging/ in S3
                                                 │ rejected (error codes)
                                                 ▼
                                      Assistant (chat) ── diagnose ──► propose skill update  (universal)
                                                                    └► save memory          (situational)
```

Phase 0 + Phase 1 scope: simulated trigger, email review, deal review/approve/edit/reject,
mock upload with structured failures, chatbot + memory manager, skills tab with proposals.

## 2. Runtime shape

- **Frontend**: the existing Next.js app, run locally with `npm run dev`. Its server routes
  (the BFF) call AWS directly with the developer's credentials against a deployment of the
  reconciliation console's root; §13 describes the same code deployed as the second app of that
  console, behind its shell, identity provider and task role.
- **Parsing agent**: Python Lambda `<name_prefix>-pipeline-parser`. A Bedrock Converse tool-use
  loop (plain boto3, no framework) with tools `lookup_security_master` and `stage_deal`
  (structured output). Skills are loaded from S3 at each run; edge-case memories are recalled
  from AgentCore Memory before the first model call and injected as advisory context.
- **Mock OMS**: Python Lambda `deal-pipeline-dev-oms-upload`. Validates a staging CSV against
  the OMS rules in §6 and returns `{accepted, errors[]}`; accepted files are copied to
  `oms-staging/`.
- **Assistant**: BFF route streaming Bedrock Converse with tools (§7). Chat turns are written
  to a short-term AgentCore Memory so a session survives reload.
- **Storage**: one S3 bucket, three DynamoDB tables, two AgentCore Memories, one SSM parameter.
- **Terraform**: `infra/modules/deal-pipeline`, composed into `infra/environments/recon` behind
  `enable_deal_pipeline`, sharing the root's `lambda-package` zip, `lambda-logs`,
  `agentcore-memory` and `seeded-object` modules. (A standalone root with local state and a
  `Project = deal-pipeline-demo` tag existed while the app was built alone; it was dropped in
  2026-09 when the app joined the console.) The recon environment
  composes the same module when `enable_deal_pipeline = true`, under its own prefix and its own
  (untagged) provider (§13).

## 3. Naming and tagging

| Thing | Value |
| --- | --- |
| name prefix | `<name_prefix>-pipeline` (e.g. `recon-dev-pipeline`) from the recon root's `name_prefix`; the names below are written with the historical `deal-pipeline-dev` prefix and shift accordingly (§13) |
| S3 bucket | `deal-pipeline-dev-assets-<account_id>` |
| DynamoDB | `deal-pipeline-dev-emails`, `deal-pipeline-dev-deals`, `deal-pipeline-dev-skill-proposals` |
| Memories | `deal_pipeline_dev_knowledge` (strategy `edge_cases`), `deal_pipeline_dev_chat` (no strategy, 7-day expiry) |
| Lambdas | `deal-pipeline-dev-parser`, `deal-pipeline-dev-oms-upload` |
| SSM | `/deal-pipeline-dev/agent-model-id` (default `us.anthropic.claude-sonnet-5`; the parser reads it through `recon_core.model_select`, so a stored id outside the six-entry allowlist the BFF enforces falls back to the default) |
| Tag | none: the module tags nothing and the recon provider sets no `default_tags`; find the pipeline's resources by the `<name_prefix>-pipeline` prefix or through the root's state |

S3 layout:

```
skills/<name>/SKILL.md          agent skills (seeded from agent-blueprint/deal-pipeline-agent/skills)
prompts/parser-system.md        parsing agent system prompt (seeded once, editable in the Skills tab)
prompts/assistant-system.md     desk assistant system prompt (seeded, tracks the repo on every apply;
                                no UI editor, fixed key in src/lib/pipeline/server/env.ts)
security-master/issuers.csv     fictional issuer reference data (seeded from data/security-master)
security-master/counterparties.csv  OMS canonical arranger names + aliases (seeded)
samples/<file>.json             the simulated inbox's corpus (seeded from data/deal-emails, file
                                names verbatim; read by the BFF when data/ is not on disk, §13)
emails/<email_id>.json          raw email as received
deal-csv/<deal_id>.csv          staging CSV awaiting review (regenerated on edit)
oms-staging/<deal_id>.csv       accepted uploads (written by the mock OMS)
```

## 4. Data model

### Email (`emails` table, pk `email_id`)

```
email_id        string   ULID-ish, e.g. "em_20260810T134200_northwind"
received_at     ISO-8601
source_kind     "news-alert" | "bank-notice" | "manual"
from, to, cc, subject, sent (ISO-8601)
body            string (plain text)
sample_id       string | null   corpus id when simulated
status          "RECEIVED" | "PARSING" | "PARSED" | "PARSE_FAILED"
deal_id         string | null
parse           ParseOutput | null   (see below)
error           string | null
updated_at      ISO-8601
```

### ParseOutput (stored on the email and copied onto the deal)

```
fields          { [field_key]: string }        every OMS field key; "" when blank
evidence        { [field_key]: { value, confidence: "high"|"medium"|"low", excerpt, rule?: string } }
                excerpt = the email text the value came from; rule = skill/memory rule applied
assumptions     string[]                        things the agent inferred without direct evidence
memory_hits     { record_id?, text }[]          recalled memories that were relevant
skills_used     string[]                        skill names loaded
enrichment      { issuer_match: string|null, fields_from_security_master: string[] }
model_id        string
duration_ms     number
```

### Deal (`deals` table, pk `deal_id`, GSI `by_email` on `email_id`)

```
deal_id         string   "dl_<ulid>"
email_id        string
opportunity_name string  (denormalized for lists)
status          "STAGED" | "APPROVED" | "UPLOADED" | "UPLOAD_FAILED" | "REJECTED"
fields          { [field_key]: string }   current values (edits land here)
original_fields { [field_key]: string }   as parsed, for diffing
evidence, assumptions, memory_hits, skills_used, enrichment   copied from ParseOutput
csv_key         string   "deal-csv/<deal_id>.csv"
upload          UploadResult | null
history         { at, actor, action, detail? }[]   STAGED / EDITED / APPROVED / UPLOAD_ACCEPTED / UPLOAD_REJECTED / REJECTED
created_at, updated_at
```

### UploadResult

```
attempted_at    ISO-8601
accepted        boolean
staging_key     string | null   "oms-staging/<deal_id>.csv" when accepted
errors          { code, field: string|null, message, hint?: string }[]
validator_version string
```

### SkillProposal (`skill_proposals` table, pk `proposal_id`)

```
proposal_id     string
skill_name      string          e.g. "deal-parsing"
summary         string          one line
rationale       string
proposed_content string         full replacement SKILL.md content
current_content  string         snapshot at proposal time (for the diff view)
status          "PENDING" | "APPROVED" | "REJECTED"
source          { kind: "assistant"|"manual", session_id?, deal_id? }
created_at, decided_at, decided_by
```

## 5. OMS staging CSV

Schema: `backend/deal_pipeline/oms_fields.json` (mirrored at
`chatbot-app/frontend/src/lib/pipeline/omsFields.json`; a test asserts they match). One CSV per
deal: header row = every `label` in array order, one data row. Formats by `type`:

| type | format | example |
| --- | --- | --- |
| date | `M/D/YYYY` | `8/13/2026` |
| time | `h[:mm]AM\|PM` | `12PM`, `1:15PM` |
| percent | 3 decimals + `%` | `2.000%` (S+200) |
| mm | millions, 3 decimals | `500.000` |
| price | 3 decimals | `99.500` |
| integer | digits | `3` |
| boolean | `Yes` / `No` / blank | `Yes` |
| enum | exact value from `values` | `Loan` |

Internal-decision fields are left blank by the agent; `pipeline_status` defaults to `New` and
`pct_commit` to `0.000%`.

## 6. Mock OMS validation rules

`backend/deal_pipeline/oms_validator.py`. Each failure has a stable `code`. Rules marked
**gap** are deliberately NOT covered by the initial skill so the learning loop has something
to learn; the fix column says which tier the assistant should propose.

| code | rule | initial skill covers? | fix tier |
| --- | --- | --- | --- |
| `HEADER_MISMATCH` | header must equal the schema labels in order | yes | – |
| `REQUIRED_MISSING` | every `required` field non-blank | yes | – |
| `FORMAT_INVALID` | value matches its type format (§5) | yes | – |
| `ENUM_INVALID` | enum value in `values` | yes | – |
| `OPP_NAME_INVALID` | ≤ 60 chars, no `$` or digits-with-MM amounts | yes | – |
| `COVENANT_STATUS_REQUIRED` | Loan records must carry Covenant Status # (1–4) | **gap** | skill (universal) |
| `LEFT_AGENT_UNKNOWN` | Left Agent must be an OMS canonical counterparty (`security-master/counterparties.csv`); message includes nearest alias match | **gap** | skill (universal) |
| `PROJECT_FINANCE_LIEN` | if UOP = Project Finance then Secured Level must be `First Lien` | **gap** | memory (situational) |
| `ADDON_NEW_MONEY` | if Opportunity Name contains "add-on" or "incremental" then New Money (MM) required and equal to Issue Size | **gap** | memory (situational) |
| `BOND_FIXED` | Bond records: Fixed/Floating = Fixed, Floor Talk blank | yes | – |
| `IG_FLAG` | Is Investment Grade? must be Yes when S&P issue rating is BBB- or better | **gap** | memory (situational) |

The validator response also carries `hint` text per error written the way a real system's
documentation would, so the assistant has something to reason from.

## 7. Assistant tools (BFF, Bedrock Converse streaming)

| tool | effect |
| --- | --- |
| `list_deals(limit)` | recent deals with status |
| `get_deal(deal_id)` | fields, evidence, upload result, history |
| `get_email(email_id)` | raw email + parse output |
| `list_skills()` / `get_skill(name)` | catalog / full SKILL.md |
| `list_counterparties()` | OMS canonical counterparty names + aliases from `security-master/counterparties.csv` |
| `propose_skill_update(skill_name, edits \| append_markdown \| proposed_content, summary, rationale)` | server applies targeted edits (each `find` must occur once) or appends a section to the live SKILL.md and writes a PENDING SkillProposal; never edits S3 directly |
| `list_memories()` | consolidated records in `deal-pipeline/edge-cases/deal-desk` |
| `save_memory(rule, rationale)` | CreateEvent in the knowledge memory (actorId `deal-desk`, sessionId `chat-<session_id>`), USER message = rule + rationale. **Admin only**: withheld from the model and refused for non-admin sessions |
| `delete_memory(record_id)` | BatchDeleteMemoryRecords. **Admin only**, same gate |

System prompt: explain the two tiers, prefer asking the user to confirm before writing, and
classify: a rule that applies to every deal → skill proposal; a rule conditioned on a deal
attribute, source format or counterparty → memory.

Stream protocol (`text/event-stream`, one JSON object per `data:` line):

```
{"type":"text","delta":"..."}
{"type":"tool_call","name":"get_deal","input":{...}}
{"type":"tool_result","name":"get_deal","ok":true,"summary":"..."}
{"type":"done","session_id":"..."}
{"type":"error","message":"..."}
```

## 8. Memory design

- `deal_pipeline_dev_knowledge`: strategy `edge_cases`, type CUSTOM, `SEMANTIC_OVERRIDE`
  extraction prompt tuned to extract *reusable deal-parsing rules* and return an empty list for
  chatter. Namespace `deal-pipeline/edge-cases/{actorId}`; the desk uses actorId `deal-desk`.
  Written by the assistant's `save_memory` tool and by the Memory Manager's manual add. Read by
  the parser (`retrieve_memory_records`, query = subject + first 600 chars, top 6) and by the
  Memory Manager panel.
- `deal_pipeline_dev_chat`: events only, 7-day expiry. actorId = user subject, sessionId =
  chat session. The assistant rebuilds history from `list_events` on load.

## 9. BFF API (all under `/api/pipeline`, gated by `src/proxy.ts`)

The proxy verifies the token and, in the console, matches the caller's groups against
`PIPELINE_ACCESS_GROUP` before any handler below runs (§13). Identity comes from the shell's one
`/api/me` read (`src/lib/shell/viewer.ts`), projected into this app by `useAppSubject("pipeline")`;
this app has no `/me` route of its own.

| route | verbs | notes |
| --- | --- | --- |
| `/samples` | GET | corpus list `{id, subject, source_kind, sent, from}`; read from `SAMPLE_EMAILS_DIR` when that directory exists, else from the assets bucket under `PIPELINE_SAMPLES_PREFIX` (§13). Ids are the file/object name without `.json` in both |
| `/emails` | GET, POST | list; POST `{sample_id}` or `{raw:{from,subject,body,sent}}` → creates email, async-invokes parser, returns email; `raw.body` ≤ 200 KB and each header line ≤ 1 KB (UTF-8), else 400 |
| `/emails/[id]` | GET | email incl. parse |
| `/emails/[id]/reparse` | POST | status → PARSING, re-invoke; 409 while a parser run is already in flight (the PARSING write is conditional, so two concurrent reparses start one run) |
| `/deals` | GET | list (newest first) |
| `/deals/[id]` | GET, PATCH | PATCH `{fields}` → validate types client-side, store, regenerate CSV, history EDITED; **admin-gated**; 409 when the status changed between read and write |
| `/deals/[id]/csv` | GET | text/csv download |
| `/deals/[id]/approve` | POST | status APPROVED → invoke OMS Lambda sync → UPLOADED / UPLOAD_FAILED; **admin-gated**; the APPROVED write is conditional on the status read (409 on conflict, Lambda not invoked); the post-upload reload is a strongly consistent read |
| `/deals/[id]/reject` | POST | `{reason}`; **admin-gated**; conditional on the status read (409 on conflict) |
| `/chat` | POST | SSE stream (§7); body `{session_id, message, context?:{deal_id?, email_id?}}`; open to all, but `save_memory` / `delete_memory` are offered to the model and executed only for admin-group callers (same gate as `/memory` POST/DELETE) |
| `/chat/history` | GET | `?session_id=` → messages from chat memory |
| `/memory` | GET, POST, DELETE | records / manual add `{rule}` / `{ids}`; POST and DELETE **admin-gated** |
| `/memory/strategy` | GET | GetMemory projection |
| `/skills`, `/skills/[name]` | GET, PUT / GET, PUT, DELETE | S3 SKILL.md catalog; writes **admin-gated** |
| `/skills/system-prompt` | GET, PUT | `prompts/parser-system.md`; PUT **admin-gated** |
| `/skills/proposals` | GET, POST | list / manual proposal |
| `/skills/proposals/[id]` | POST | `{decision: "approve"|"reject"}`; **admin-gated**; approve writes S3, or 409 when the live skill no longer matches the proposal's `current_content` |
| `/config` | GET, PUT | GET `{modelId, modelIds, consoleDefaultModelId}` — the app's own parameter via SSM plus the console-wide default an admin may copy (§14), raw and null when none is set; PUT `{modelId}` from the allowlist, **admin-gated** |

Authorization: `ALLOW_ANONYMOUS_API=true` admits everything (local dev; `ANONYMOUS_GROUPS`
narrows the anonymous subject to named groups to preview a restricted user). The older
`RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API` are the same switch — any of the three
being exactly `true` opens both BFFs, and none may be set in a deployment. `PIPELINE_ACCESS_GROUP`
decides who may call any of these routes at all — unset, every authenticated user may, unless
`REQUIRE_ACCESS_GROUPS=true`, in which case a blank group denies everyone but admins (§13).
`PIPELINE_ENABLED=false` takes the whole app away: `/api/me` reports no access and the proxy answers
403 here regardless of groups. All three names — the two groups and the switch — may also be
supplied by the console's stored layer (§14), which overlays the same environment names before
`resolveAppAccess` reads them; nothing in this app's BFF reads that layer directly, and the
console's own `/api/console/*` routes sit outside this prefix and belong to the shell.
`PIPELINE_ADMIN_GROUP` gates every route that changes what the next parse does or what reaches
the OMS: approve/reject, field edits (PATCH `/deals/[id]`), skill and parser-prompt writes,
proposal decisions, memory add and delete (the REST routes and the assistant's `save_memory` /
`delete_memory` tools alike), config PUT; admins implicitly have access. Reading, chatting,
simulating an email, reparsing and proposing a skill change stay open to every user with access —
none of them changes the OMS or the parser without an admin's decision.

## 10. Frontend

Routes under `/pipeline`: `inbox`, `inbox/[id]`, `deals`, `deals/[id]`, `assistant`,
`skills`, `skills/[name]`, `skills/system-prompt`, `skills/proposals`, `config`. `/` is the
console's landing chooser (§13), which sends a viewer with access to exactly one app straight
into it — for a pipeline-only viewer that is `/pipeline/inbox`. Beside this tree the console
serves the reconciliation app (`/recon/*`, `/api/recon/*`), the shell's `/api/me`, its Settings
screen at `/console/settings` with `/api/console/*` behind it (§14), the provider's OIDC redirect
target (`/callback` for Cognito, the default; `/login/callback` for Okta; Entra returns to the origin),
the liveness endpoints `/health` and `/api/health`, and the BFF in §9. `config`
carries the one console-aware control in this app: **Use console default** beside the parser-model
presets, which copies the console-wide default model id into this app's own parameter through the
same admin-gated PUT (§14); every other setting on that screen is this app's own. This app's own
primitives are `src/components/pipeline/ui.tsx` (its `StatusPill` and `ConfidenceChip`) and its panels
(`EmailViewer.tsx`, `DealFieldGrid.tsx`, ...). The header chrome (`AppChrome`, `AppNav`, `UserMenu`),
the column-preferences `DataTable` and the generic primitives (Panel, Pill, Modal, Notice, buttons)
are shared with the recon app in `src/components/app-ui/`; neither app imports the other. Theme CSS:
`src/app/app-theme.css`, shared, `rc-` prefix, scoped to `.app-root`.

## 11. Environment (`chatbot-app/frontend/.env.local`)

```
ALLOW_ANONYMOUS_API=true
# ANONYMOUS_GROUPS=deal-desk
PIPELINE_ACCESS_GROUP=
PIPELINE_ADMIN_GROUP=deal-desk-admins
# REQUIRE_ACCESS_GROUPS=true   (console: blank access group denies instead of opens)
# PIPELINE_ENABLED=false       (console: switch this app off; unset = enabled)
CONSOLE_SETTINGS_PREFIX=/deal-pipeline-dev/console
CONSOLE_ADMIN_GROUP=console-admins
# CONSOLE_ORGANIZATION_LABEL=Agentic Operations Console
# CONSOLE_DEFAULT_MODEL_ID=
NEXT_PUBLIC_AUTH_PROVIDER=cognito
AWS_REGION=us-east-1
PIPELINE_ASSETS_BUCKET=
EMAILS_TABLE=
DEALS_TABLE=
SKILL_PROPOSALS_TABLE=
KNOWLEDGE_MEMORY_ID=
CHAT_MEMORY_ID=
PARSER_FUNCTION=
OMS_UPLOAD_FUNCTION=
PIPELINE_AGENT_MODEL_PARAM=/deal-pipeline-dev/agent-model-id
ASSISTANT_MODEL_ID=us.anthropic.claude-sonnet-5
SAMPLE_EMAILS_DIR=../../data/deal-emails
PIPELINE_SAMPLES_PREFIX=samples/
PIPELINE_SKILLS_PREFIX=skills/
PARSER_PROMPT_KEY=prompts/parser-system.md
```

`src/lib/pipeline/server/env.ts` is the single reader of these names. Three of them carry a
`PIPELINE_` prefix and are read **only** under that prefix — `PIPELINE_ASSETS_BUCKET` (required),
`PIPELINE_AGENT_MODEL_PARAM` (required), `PIPELINE_SKILLS_PREFIX` (default `skills/`) — with no
fallback to `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` or `SKILLS_PREFIX`, because in the console the
recon BFF owns the bare names in the same process (§13) and a fallback would have read recon's
values without an error. The recon root's `terraform output -raw frontend_env_local` renders the
prefixed names for a laptop; the deployment sets the same ones on the task. `PIPELINE_SAMPLES_PREFIX`
(default `samples/`) names where the corpus lives in S3 when `SAMPLE_EMAILS_DIR` does not exist on
the server. The Lambdas are separate processes and keep `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` and
`SKILLS_PREFIX` unprefixed.

Authorization names are the console's, shared with the recon app: `ALLOW_ANONYMOUS_API` (exact
`true`) replaces token verification with one anonymous subject that holds every configured group,
or only the comma-separated groups in `ANONYMOUS_GROUPS`. `RECON_ALLOW_ANONYMOUS_API` and
`PIPELINE_ALLOW_ANONYMOUS_API` — each app's spelling from before the shell — are honoured as the
same switch, so a deployment must carry none of the three. `PIPELINE_ACCESS_GROUP` (unset = open
to every authenticated user, or denied when `REQUIRE_ACCESS_GROUPS=true`) and
`PIPELINE_ADMIN_GROUP` (unset = nobody) are read through `accessGroupFor` / `adminGroupFor` in
`src/lib/auth/apps.ts` and by `src/lib/auth/app-admin.ts`; `PIPELINE_ENABLED` (exact `false` =
app off) is the pipeline entry's `enabledEnv` in the same registry.

Four more console names are read by the shell's `src/lib/console/`, not by this app's BFF (§14):
`CONSOLE_SETTINGS_PREFIX` (the SSM prefix of the stored settings layer; unset = the layer is off and
every setting reads from the environment), `CONSOLE_ADMIN_GROUP` (who may edit console-wide settings;
environment-only, unset = nobody), `CONSOLE_ORGANIZATION_LABEL` (environment fallback for the rail's
organization label, default `Agentic Operations Console`) and `CONSOLE_DEFAULT_MODEL_ID` (environment
fallback for the console default model id; Terraform seeds the parameter instead of setting this). The
recon root renders the first three into `frontend_env_local` beside this app's names, with a prefix
of `/<name_prefix>/console`. A value stored under the prefix for `PIPELINE_ACCESS_GROUP`,
`PIPELINE_ADMIN_GROUP` or `PIPELINE_ENABLED` overlays the environment value; `env.ts` is unaffected,
because none of the names it reads is console-wide, and the only console value this app ever sees is
the default model id its `/config` GET reports.

Two further groups are read from `.env.local` and only matter with a real identity provider.
Server-side token verification — `AUTH_PROVIDER`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`,
`OKTA_ISSUER`, `OKTA_CLIENT_ID`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `AUTH_GROUPS_CLAIM` — is read
only when none of the three anonymous switches is `true`; an incomplete set is a 503 from the BFF,
never an open door. Browser-side login — `NEXT_PUBLIC_COGNITO_USER_POOL_ID`,
`NEXT_PUBLIC_COGNITO_CLIENT_ID`, `NEXT_PUBLIC_COGNITO_HOSTED_UI`,
`NEXT_PUBLIC_COGNITO_REDIRECT_URI` (optional; the browser otherwise derives it from its own origin),
`NEXT_PUBLIC_ENTRA_TENANT_ID`, `NEXT_PUBLIC_ENTRA_CLIENT_ID`, `NEXT_PUBLIC_ENTRA_API_AUDIENCE`,
`NEXT_PUBLIC_OKTA_ISSUER`, `NEXT_PUBLIC_OKTA_CLIENT_ID`, `NEXT_PUBLIC_OKTA_REDIRECT_URI` — is active
only when the provider named by `NEXT_PUBLIC_AUTH_PROVIDER` has its client settings present.

`AUTH_PROVIDER` / `NEXT_PUBLIC_AUTH_PROVIDER` unset means **`cognito`**, an Amazon Cognito user pool
the console's Terraform root creates itself (`infra/modules/console-auth`), so neither this app nor
the console needs an external identity-provider tenant to be signable-in; `okta` and `entra` are
unchanged alternatives. Leave `AUTH_GROUPS_CLAIM` unset under Cognito: a user pool emits group
membership as the reserved claim `cognito:groups`, and blank resolves per provider on both sides
(`cognito:groups`, or `groups` for Okta and Entra). Set it only when the groups arrive elsewhere,
which is the federated case — a SAML/OIDC provider mapped into the pool commonly lands them on
`custom:groups`. The repository README's "Authentication" section is the whole picture, including
federation and cost. `chatbot-app/frontend/.env.example` is the template for the whole console: the
shared authorization block, then the recon variables, then this app's.

## 12. Demo script

1. Inbox → **Simulate incoming email** → pick the insurance-brokerage refinancing → watch it
   move RECEIVED → PARSING → PARSED; open it to see raw email beside parsed fields with evidence.
2. Deals → open the staged deal → Approve. The mock OMS rejects it: `COVENANT_STATUS_REQUIRED`
   and `LEFT_AGENT_UNKNOWN` (nearest: "Silverline").
3. Assistant → "The upload for the Copperfield deal failed, what should we change?" The
   assistant reads the deal, explains both errors, proposes a **skill update** (loans always
   carry Covenant Status #, cov-lite → 3; arranger names use the OMS canonical list) and offers
   to save it. Approve the proposal on the Skills tab.
4. Simulate the pipeline project-finance deal → approve → `PROJECT_FINANCE_LIEN` fails →
   assistant saves a **memory** ("project-finance TLBs are First Lien in the OMS").
5. Re-simulate either email → parsed correctly, upload accepted. Memory Manager shows the
   consolidated record; Skills shows the applied proposal.

## 13. Integration into the console

Decided 2026-09-11: the pipeline ships as the second application of the reconciliation console
rather than as a separate deployment. The recon app's routes, hooks and tabs are untouched and so are
this app's; its theme is now the shared `app-theme.css` with the same tokens; a shell around both adds
what neither had.

**Shell.** `/` is a landing chooser with one card per app the signed-in viewer may open (a viewer
with exactly one app is sent straight into it). Inside an app a collapsible vertical rail on the
left switches between the apps the viewer has access to. The registry behind both is
`src/lib/auth/apps.ts`: id, label, page prefix (`/pipeline`), BFF prefix (`/api/pipeline`), the
two group variable names per app and, for this app only, `enabledEnv: "PIPELINE_ENABLED"` — the
value `false` (exact) makes `resolveAppAccess` report `{access: false, admin: false}`, so `/api/me`
hides the app and the proxy 403s `/api/pipeline/*`; unset or anything else is enabled, and recon
has no such switch. `/api/me` returns the `Viewer` — subject, groups, auth mode (`anonymous`,
`cognito`, `okta` or `entra`, mirroring `VerifiedAuthMode` in `src/lib/api-auth.ts`) and
`apps.<id>.{access, admin}` — and, since the console layer (§14), `console.{admin, configured,
organizationLabel}` and the caller's own `preferences`; the shell renders from that alone.

**Access groups.** Permissions come from the identity-provider group claim the BFF already verifies
(`AUTH_GROUPS_CLAIM`). Each app has an access group and an admin group; admins implicitly have
access. For this app: `PIPELINE_ACCESS_GROUP` and `PIPELINE_ADMIN_GROUP`; for recon,
`RECON_ACCESS_GROUP` and `RECON_ADMIN_GROUP`, read through `accessGroupFor` / `adminGroupFor`
(trimmed, `""` when unset) from the environment as overlaid by the console's stored layer (§14). An
unset access group leaves that app open to every authenticated user —
the behaviour a recon-only deployment had before the shell — and an unset admin group fails closed,
as before. That open default is only safe while one population signs in, so the console has
`REQUIRE_ACCESS_GROUPS`: exactly `true` makes a blank access group **deny** the app to everyone but
its admins. The composed deployment sets it whenever the pipeline is enabled, and the recon root
refuses to plan `enable_deal_pipeline = true` while either access group is blank — **except** under
`auth_provider = "cognito"` (the default), where the premise no longer holds: the user pool
`infra/modules/console-auth` creates owns all four app groups plus the console-admin group, and the
root's `local.console_groups` resolves a blank variable to the group the pool actually created
(`deal-desk` and `deal-desk-admins` for this app), handing the console that name. So the four names
always reach the task non-blank there and "blank access group = open" never arises; what still fails
closed is membership, because every group is created **empty**. Under Okta or Entra nothing in
Terraform can create a group, `""` reaches the console as `""`, and the paragraph above holds
unchanged. `scripts/create_dev_users.py` populates the pool's groups with five demonstration accounts
— one of them pipeline-access only, one an admin of both apps — which is how the split described here
is checked in a browser. `src/proxy.ts`
applies the access check to every `/api/pipeline/*` and `/api/recon/*` request before the handler
runs. Behind it the two apps differ: every admin-gated route in §9 re-checks `PIPELINE_ADMIN_GROUP`
for itself, whereas on the recon side only `config/*`, `memory` DELETE and `uploads` re-check
`RECON_ADMIN_GROUP` — recon's `system-prompt`, `skills`, `harness/configs`, `evals/batch`,
`idp-extractions` and bulk `cases` writes are gated by access alone, so `RECON_ACCESS_GROUP` is the
boundary around what the reconciliation agent does (the README's "Two applications, one console"
lists both sets). The rail not showing an app is a courtesy on top of the gate. Local development
uses anonymous mode, which grants every app and both admin roles; `ANONYMOUS_GROUPS` previews a
restricted user (§11).

**Prefixed environment names.** Both BFFs run in one Next.js process, and the recon side already
owns `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` and `SKILLS_PREFIX` in the container's environment. The
pipeline BFF therefore reads `PIPELINE_ASSETS_BUCKET`, `PIPELINE_AGENT_MODEL_PARAM` and
`PIPELINE_SKILLS_PREFIX`, and **only** those: there is no fallback to the bare names, because in
the composed task the bare ones exist and are recon's, so a fallback would have read recon's
bucket, model parameter or skills without any error. A missing `PIPELINE_ASSETS_BUCKET` or
`PIPELINE_AGENT_MODEL_PARAM` fails the first request that needs it, naming the variable;
`PIPELINE_SKILLS_PREFIX` defaults to `skills/`. The recon root's `frontend_env_local` output renders
the prefixed names as well. `PIPELINE_SAMPLES_PREFIX` is new and pipeline-only.

**Composed Terraform.** `infra/environments/recon` gains `enable_deal_pipeline` (default `false`).
When true it instantiates `infra/modules/deal-pipeline` beside `modules/frontend-ecs`, grants the
console's task role the bucket, table, memory, Lambda and SSM access this app needs, and passes the
task the §11 variables under the prefixed names together with `PIPELINE_ENABLED=true` and
`REQUIRE_ACCESS_GROUPS=true`; with the flag off the task carries `PIPELINE_ENABLED=false` and no
pipeline environment or grants. Under `auth_provider = "okta"` or `"entra"` the plan is refused while
`recon_access_group` or `pipeline_access_group` is blank; under the default `"cognito"` it is not,
because the pool creates both groups and the root passes the console their names (see **Access
groups** above). The module creates the same *kinds* of resources as §3, but
**not the same names or tags**: the composed root instantiates it with
`name_prefix = "<name_prefix>-pipeline"` (default `recon-dev-pipeline`), so the §3 names become
`recon-dev-pipeline-emails`, `recon-dev-pipeline-assets-<account_id>`,
`/recon-dev-pipeline/agent-model-id`, `recon_dev_pipeline_knowledge` and so on — so nothing the
pipeline creates can collide with a recon name — and the recon provider sets no `default_tags`. Find
the pipeline's resources by the `<name_prefix>-pipeline` prefix or through the root's Terraform
state. Running this app alone against `npm run dev` means running it against such a deployment,
with `.env.local` rendered by `terraform output -raw frontend_env_local`. That deployment does not have
to include the serving tier: `enable_frontend_tier = false` skips the container build, ECS service, ALB
and CloudFront while creating every table, bucket, Lambda and memory this app reads, and the same
output still renders a complete `.env.local` — composed from the root's own values rather than read
back from a task definition that does not exist. The repository README's "The cheap development
profile" lists the five flags and what that profile does **not** exercise.

**Samples from S3 in the container.** The console image holds the built app and no `data/`, so
the simulated inbox cannot read `data/deal-emails` there. `infra/modules/deal-pipeline` seeds the
corpus to the pipeline bucket under `samples/<file>.json`, keeping the file names verbatim, and
`src/lib/pipeline/server/samples.ts` reads from the directory when it exists and from
`PIPELINE_SAMPLES_PREFIX` when it does not. Both sources yield the same `SampleEmail` shape and the
same ids (the file or object name without `.json`), so a sample picked from the dialog in either
environment reads back on the next request. Nothing is cached in either mode; a new sample on disk
shows up on the next open, and a new sample in S3 after the apply that seeded it.

**Decoupling.** The two apps share the identity spine (`src/lib/auth/`, including `provider.ts`, the one reader of `NEXT_PUBLIC_AUTH_PROVIDER`, `cognito-pkce.ts`, the default provider's browser flow, `client-token.ts`, the one browser-side ID-token reader, `authed-fetch.ts`, which `recon-auth.ts` binds for recon and `pipelineApi.ts` imports directly, and `app-admin.ts`; `src/lib/api-auth.ts`,
`src/lib/reauth.ts`), the `src/components/ui/` primitives and a few app-agnostic helpers, and
nothing else: no import crosses from `src/{app,components,lib,hooks}/*pipeline*` into `*recon*` or
back. Adding a third app is one entry in `APPS` plus its own route trees.

## 14. Console-wide configuration

Decided 2026-09-11, with the console. The contract is `src/lib/console/types.ts`; the store is
`src/lib/console/settings.ts`; the registry it overlays is `src/lib/auth/apps.ts`.

**Scope.** Everything that applies to the console as a whole, and nothing that applies to one app:
which identity-provider group may use or administer each app, which apps are deployed, defaults an
app may copy, and each user's own preferences. Per-app configuration stays exactly where §9 and §11
put it — this app's parser model in `PIPELINE_AGENT_MODEL_PARAM`, the recon app's threshold, backend,
Tier-1, model, contacts, templates and workflow types in its own parameters and Config tab — and the
console layer never writes an app's parameter. The recon Config tab does not change. A setting moves
up into this layer only by decision, recorded here; it is not a refactor.

**Storage.** AWS Systems Manager Parameter Store, one String parameter per setting under
`CONSOLE_SETTINGS_PREFIX`. The root sets `/<name_prefix>/console` (`/recon-dev/console`):

| parameter | value | environment name it overlays |
| --- | --- | --- |
| `<prefix>/access/<appId>/access-group` | IdP group that may use the app; absent = see env / default | `RECON_ACCESS_GROUP`, `PIPELINE_ACCESS_GROUP` |
| `<prefix>/access/<appId>/admin-group` | IdP group that administers the app | `RECON_ADMIN_GROUP`, `PIPELINE_ADMIN_GROUP` |
| `<prefix>/apps/<appId>/enabled` | `"true"` or `"false"`; only for apps with an `enabledEnv` | `PIPELINE_ENABLED` (recon has none and is always enabled) |
| `<prefix>/defaults/model-id` | Bedrock model or inference-profile id an app may copy | `CONSOLE_DEFAULT_MODEL_ID` |
| `<prefix>/defaults/organization-label` | label shown under the console mark in the rail | `CONSOLE_ORGANIZATION_LABEL` (default `Agentic Operations Console`) |
| `<prefix>/prefs/<sha256(subject) hex, first 32 chars>` | one user's `UserPreferences`, as JSON | none |
| `<prefix>/meta/updated` | `{"at": ISO time, "by": subject}` of the last save through the API | none |

`appId` is `recon` or `pipeline`, the ids in `APPS`. A settings read fetches the `access`, `apps`,
`defaults` and `meta` subtrees; `prefs/` is never listed (one row per user, unbounded). Blank values
are dropped on read, so a blank parameter behaves like an absent one.

**Resolution.** For every setting: stored (non-blank) → environment variable → default.

1. Read the four subtrees in one pass (paginated). Each process caches the result for **30 seconds**
   (`OVERLAY_TTL_MS`), sharing one in-flight read so a burst after expiry costs one SSM call.
2. Build an overlaid copy of the environment: for each parameter with an environment name in the
   table, the stored value replaces the environment value; an absent parameter leaves the
   environment value as it is.
3. Hand that overlaid environment (`effectiveEnv()`) to the readers the registry already has —
   `resolveAppAccess`, `isAppEnabled`, `accessGroupFor` / `adminGroupFor`, `decideApiAccess` in the
   proxy, and the admin gate `lib/auth/app-admin.ts` (`reconAdmin.ts` binds it for recon). None of them changes; the
   `env` parameter they already accept for tests is the seam. When the layer is off,
   `effectiveEnv()` returns `process.env` itself.
4. Report each resolved value with its `SettingSource` — `stored`, `env` or `default` — and the
   environment name that would supply it when nothing is stored, so the UI can show the chip and the
   fallback.
5. Three names never enter the overlay: `REQUIRE_ACCESS_GROUPS`, `ALLOW_ANONYMOUS_API` (with
   `RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API`) and `CONSOLE_ADMIN_GROUP`. They are
   read from the process environment only and reported in `envOnly` for transparency.
6. **Failure policy.** The proxy asks the layer on every BFF request, so a Parameter Store failure
   (throttling, a NAT blip in `private_vpc` mode, a missing grant after a deploy) must not become a
   console-wide outage: when the read fails, the layer resolves from the environment alone for one
   cache window and logs it once. For that window a restriction that exists only in the stored layer
   is not enforced; a deployment that cannot accept that names the group in the environment too, and
   the stored value merely overrides it. The Settings screen's own read does not fail open — an admin
   sees the error, never a screen claiming every value comes from the environment.
7. **Propagation.** A save drops the cache of the process that wrote, so the admin sees the result
   at once. The proxy is a separate Next bundle with its own cache, so even on the same task the
   access gate learns of the change within 30 seconds, as does every other task. There is no
   cross-instance signal by design: settings change rarely, and a 30-second lag on an access-group
   edit is acceptable where a message bus would not be worth its own failure modes.
8. `CONSOLE_SETTINGS_PREFIX` unset: the layer is off. Every setting resolves from the environment as
   before the layer existed, `/api/console/settings` reports `configured: false` with every field from
   env/default, the Settings screen renders read-only with a note saying why, and preferences fall
   back to the browser.

**Routes.** All verify the token themselves, like `/api/me` (defence in depth: a matcher change must
not turn them into an unauthenticated settings oracle). `src/proxy.ts` matches `/api/console/:path*`
and admits these routes on authentication alone; the console-admin check is inside each route. Every
response carries `Cache-Control: no-store`.

| route | verbs | who | notes |
| --- | --- | --- | --- |
| `/api/me` | GET | any authenticated user | the §13 `Viewer` (its `apps` resolved on the overlaid environment) plus `console.{admin, configured, organizationLabel}` and the caller's `preferences` (`ViewerConsoleFields`); a preferences read failure yields `{}` rather than failing the route |
| `/api/console/settings` | GET, PUT | console admins | GET → `ConsoleSettings`: `configured`, `prefix`, `access.<appId>.{accessGroup, adminGroup}`, `apps.<appId>.enabled`, `defaults.{modelId, organizationLabel}`, `envOnly`, `updatedAt` / `updatedBy`; reads Parameter Store fresh; 403 for a non-admin (the body names every group that gates every app), 500 when the read fails. PUT → `ConsoleSettingsUpdate`: every field optional, only the fields present are written, `""` deletes the stored parameter so the setting falls back to env; the whole body is validated before anything is written; records `meta/updated`; answers with the refreshed settings; 400 naming the bad field, 409 when the layer is not configured |
| `/api/console/access-check?groups=a,b` | GET | console admins | `AccessCheckResult`: what a hypothetical user holding exactly those groups would see — `apps.<appId>.{access, admin}` through `resolveAppAccess` on the overlaid environment, and `consoleAdmin` from the environment. An empty list is a legitimate question ("a user in no groups") |
| `/api/console/preferences` | GET, PUT | any authenticated user | the caller's own row only, keyed by the hashed subject from the verified token; `UserPreferences` = `defaultApp?`, `railCollapsed?`, `theme?` (`system` / `light` / `dark`); GET answers `{}` when nothing is stored or the layer is off; PUT replaces the whole row, 400 on a bad field, 409 when the layer is off |

Validation limits, shared by the API and the UI (`types.ts`): group names at most `GROUP_NAME_MAX`
(128) characters matching `GROUP_NAME_PATTERN` (`^[A-Za-z0-9 _.:@/-]+$`); the organization label at
most `ORGANIZATION_LABEL_MAX` (60) characters; a model id matching `MODEL_ID_PATTERN`
(`^[A-Za-z0-9._:/-]+$`); `enabled` a boolean. Group names are trimmed on write, so what is stored is
what `accessGroupFor` will compare against. The Terraform seeds (below) are validated to the same
limits at plan, so a seed the UI could not have written is refused instead of rendering as a value
the operator cannot re-save.

**The Settings screen.** `/console/settings` (`/console` redirects there), reached from the Settings
entry in the rail's footer, which every authenticated viewer sees. `/console/*` is not an app: it has
no `APPS` entry, no access group and no BFF prefix, so the shell recognises it separately
(`src/lib/shell/consolePaths.ts`) and renders it without the per-app access panel. Five sections,
addressed by `?tab=` so each is linkable: **Access** (each app's access and admin group), **Applications**
(the enablement switch of each app that has one), **Defaults** (model id, organization label), **Users**
(who the console takes the viewer for, and the access checker) and **Preferences** (the viewer's own).
The first three hold admin data: a console admin sees resolved values with a source chip beside each
and a "Last saved" line from `meta/updated`; anyone else sees the structure — which environment name
supplies each value, per app — without the values, and never triggers the GET that would 403. A
console admin lands on Access, everyone else on Preferences. Editable means both a console admin and a
configured layer; the note at the top of an admin section says which is missing. Saving sends only
the fields the operator changed, so an environment value that was merely displayed never becomes a
stored one, and the screen adopts the server's response rather than its own request so the chips say
where each value now comes from.

**Security boundary.** What an edit from the Settings screen can and cannot do:

- A console admin **may** rename the access or admin group of either app, switch the pipeline on or
  off, and set the two defaults. Renaming a group changes who may enter; that is the power the role
  is trusted with, and it is bounded by the identity provider, which is the only place membership
  exists.
- A console admin **may not** flip `REQUIRE_ACCESS_GROUPS`, switch on anonymous mode, or change
  `CONSOLE_ADMIN_GROUP`. Because those three never enter the overlay, no sequence of UI edits can
  widen access past what the deployment allows — a cleared group falls back to the environment, and
  a blank environment group under `REQUIRE_ACCESS_GROUPS=true` is still admins-only — and no UI edit
  can grant console admin to anyone. The group that gates the Settings screen is not editable from
  the Settings screen.
- `CONSOLE_ADMIN_GROUP` fails closed like the two app admin groups: unset means nobody, and the three
  admin sections show their structure without values for everyone. Anonymous local mode holds every
  configured group (`allConfiguredGroups` includes this one), so it is a console admin exactly when
  the variable is set; no anonymous switch may be set in a deployment (§9).
- Non-admins get 403 from `/api/console/settings` and `/api/console/access-check`. Preferences are per
  caller: a user can read and write their own row and no other, and the subject never appears in a
  parameter name — an OIDC subject can contain characters Parameter Store refuses, and a listing that
  spelled out every identifier would be a roster — which is why the key is a hash.
- The layer decides only what `/api/me`, the proxy and the admin helpers read; every one of them
  still runs on every request. The rail not showing an app remains a courtesy on top of the gate.
- The failure policy above is part of the boundary: a stored-only restriction is unenforced for one
  cache window after a Parameter Store failure. Name the group in the environment as well when that
  is unacceptable.

**Per-user preferences.** Stored under `<prefix>/prefs/` once the layer is configured; in the browser
(`localStorage`, the `shell:rail:collapsed` key from `src/lib/shell/railState.ts`) when it is not,
which is what the shell did before. Even when configured the browser value is used first, so the rail
never pops between states on the first paint; the stored value then wins once per `/api/me` load. The
rail's own collapse button writes the choice back to the stored row (when configured), so a click
outlives the browser instead of being undone by the stored value on the next load. The stored theme is
applied once per load through the theme switch the apps already use, and the user may change it
afterwards. `defaultApp` is where `/` sends a viewer who may use several apps and still has access to
it; a default that lost its access group falls back to the chooser, and a viewer with exactly one app
still goes straight into it.

**Inheritance: "Use console default".** The one place an app takes a value from this layer, and it is
a copy, not a link. This app's `/config` GET reports `consoleDefaultModelId` — the resolved
`defaults/model-id`, raw and null when none is set — beside the pipeline's own selection, so the
Config tab can offer **Use console default** next to its family/endpoint presets. Choosing it is the
same admin-gated PUT of `PIPELINE_AGENT_MODEL_PARAM` with that id; the parser Lambda keeps reading that
parameter alone, nothing outside this BFF learns the console default exists, the panel says when the
console default is not an id the pipeline offers, and a later change to the console default does not
move the pipeline until someone chooses it again. The recon Config tab is unchanged. No console-wide
value is ever written into an app's parameter by the console.

**Terraform.** `infra/modules/console-settings` creates the parameters at exactly the contract's keys;
both roots instantiate it with `prefix = "/<name_prefix>/console"`. It seeds all seven settings from
variables the root already has — `recon_access_group`, `recon_admin_group`, `pipeline_access_group`,
`pipeline_admin_group`, `enable_deal_pipeline` (rendered `"true"` / `"false"`), `pipeline_agent_model_id`
as the default model id — plus the new `console_organization_label` (default
`Agentic Operations Console`), so on day one the stored layer and the task environment agree and every
seeded field reads `stored`. A blank seed creates **no** parameter: SSM rejects an empty value, and any
placeholder would be read back as a stored value that outranks the environment, so skipping is the only
representation of "nothing stored" and the UI creates the parameter on first save. Every parameter
carries `ignore_changes = [value]`: Terraform seeds, the UI owns, and an apply never reverts an
operator's edit. Two consequences follow from Terraform managing existence and nothing else: clearing a
value in the UI deletes the parameter, and the next apply re-creates it from the seed unless the seed
is blanked as well (clearing for good is a two-step); and a parameter the UI created first cannot later
be adopted by giving its seed a value — the create fails with `ParameterAlreadyExists` rather than
overwrite the UI's value; import it, or leave the seed blank. `infra/environments/recon` gains
`console_admin_group` (default `""`, fail closed) and `console_organization_label`; the frontend module
receives the seeder's `prefix` output as `CONSOLE_SETTINGS_PREFIX`, `console_admin_group` as
`CONSOLE_ADMIN_GROUP` and `console_organization_label` as `CONSOLE_ORGANIZATION_LABEL`, always present
whether or not the pipeline is deployed, and its task role gets `ssm:GetParameter`, `GetParameters`,
`GetParametersByPath`, `PutParameter` and `DeleteParameter` on `parameter<prefix>` and
`parameter<prefix>/*` (region and account literal, because a delete grant should reach no further than
the parameters this console owns), plus `DescribeParameters`, which has no resource scope. The
root's `frontend_env_local` output renders the three `CONSOLE_*` names for a laptop, which then edits
in anonymous mode when `CONSOLE_ADMIN_GROUP` is set. Plan-only tests:
`infra/modules/console-settings/tests/parameters.tftest.hcl` (every seed lands
at its contract key, a blank seed creates nothing, the two prefix shapes that break the grant are
refused) and `infra/modules/frontend-ecs/tests/console_settings.tftest.hcl`. Nothing here creates a
group; `console-admins` in the examples is an identity-provider group an operator maintains, like the
four app groups.

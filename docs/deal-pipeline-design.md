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
  (the BFF) call AWS directly with the developer's credentials. No ECS, CloudFront or identity
  provider in the standalone shape; §13 describes the same code deployed as the second app of
  the reconciliation console, behind its shell, identity provider and task role.
- **Parsing agent**: Python Lambda `deal-pipeline-dev-parser`. A Bedrock Converse tool-use
  loop (plain boto3, no framework) with tools `lookup_security_master` and `stage_deal`
  (structured output). Skills are loaded from S3 at each run; edge-case memories are recalled
  from AgentCore Memory before the first model call and injected as advisory context.
- **Mock OMS**: Python Lambda `deal-pipeline-dev-oms-upload`. Validates a staging CSV against
  the OMS rules in §6 and returns `{accepted, errors[]}`; accepted files are copied to
  `oms-staging/`.
- **Assistant**: BFF route streaming Bedrock Converse with tools (§7). Chat turns are written
  to a short-term AgentCore Memory so a session survives reload.
- **Storage**: one S3 bucket, three DynamoDB tables, two AgentCore Memories, one SSM parameter.
- **Terraform**: `infra/environments/deal-pipeline` (local state) using
  `infra/modules/deal-pipeline` and the existing `lambda-package` module. Provider
  `default_tags = { Project = "deal-pipeline-demo" }` on every resource. The recon environment
  composes the same module when `enable_deal_pipeline = true` (§13).

## 3. Naming and tagging

| Thing | Value |
| --- | --- |
| name prefix | `deal-pipeline-dev` |
| S3 bucket | `deal-pipeline-dev-assets-<account_id>` |
| DynamoDB | `deal-pipeline-dev-emails`, `deal-pipeline-dev-deals`, `deal-pipeline-dev-skill-proposals` |
| Memories | `deal_pipeline_dev_knowledge` (strategy `edge_cases`), `deal_pipeline_dev_chat` (no strategy, 7-day expiry) |
| Lambdas | `deal-pipeline-dev-parser`, `deal-pipeline-dev-oms-upload` |
| SSM | `/deal-pipeline-dev/agent-model-id` (default `us.anthropic.claude-sonnet-5`) |
| Tag | `Project = deal-pipeline-demo` on everything |

S3 layout:

```
skills/<name>/SKILL.md          agent skills (seeded from agent-blueprint/deal-pipeline-agent/skills)
prompts/parser-system.md        parsing agent system prompt (seeded, editable in the Skills tab)
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
`PIPELINE_ACCESS_GROUP` before any handler below runs (§13). The shell's own `/api/me` reports
per-app access; this app's `/me` keeps answering for its own hooks.

| route | verbs | notes |
| --- | --- | --- |
| `/me` | GET | subject, groups, isAdmin |
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
| `/config` | GET, PUT | `{modelId}` via SSM; PUT **admin-gated** |

Authorization: `ALLOW_ANONYMOUS_API=true` admits everything (local dev; `ANONYMOUS_GROUPS`
narrows the anonymous subject to named groups to preview a restricted user). `PIPELINE_ACCESS_GROUP`
decides who may call any of these routes at all — unset, every authenticated user may.
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
serves the reconciliation app (`/recon/*`, `/api/recon/*`), the shell's `/api/me`,
`/login/callback` (the OIDC redirect target), the liveness endpoints `/health` and `/api/health`,
and the BFF in §9. This app's own primitives live in `src/components/pipeline/` (`ui.tsx`,
`DataTable.tsx`, `nav.tsx`, `UserMenu.tsx`, `EmailViewer.tsx`); nothing in them is imported by
the recon app or imports from it. Theme CSS: `src/app/pipeline/pipeline-theme.css`.

## 11. Environment (`chatbot-app/frontend/.env.local`)

```
ALLOW_ANONYMOUS_API=true
# ANONYMOUS_GROUPS=deal-desk
PIPELINE_ACCESS_GROUP=
PIPELINE_ADMIN_GROUP=deal-desk-admins
NEXT_PUBLIC_AUTH_PROVIDER=entra
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
`PIPELINE_` prefix with a fallback to the bare name — `PIPELINE_ASSETS_BUCKET ?? ASSETS_BUCKET`,
`PIPELINE_AGENT_MODEL_PARAM ?? AGENT_MODEL_PARAM`, `PIPELINE_SKILLS_PREFIX ?? SKILLS_PREFIX` —
because in the console the recon BFF owns the bare names in the same process (§13). The
standalone root's `terraform output -raw env_local` still renders the bare names and keeps
working; the composed deployment sets the prefixed ones. `PIPELINE_SAMPLES_PREFIX` (default
`samples/`) has no bare form: it names where the corpus lives in S3 when `SAMPLE_EMAILS_DIR` does
not exist on the server. The Lambdas are separate processes and keep `ASSETS_BUCKET`,
`AGENT_MODEL_PARAM` and `SKILLS_PREFIX` unprefixed.

Authorization names are the console's, shared with the recon app: `ALLOW_ANONYMOUS_API` (exact
`true`) replaces token verification with one anonymous subject that holds every configured group,
or only the comma-separated groups in `ANONYMOUS_GROUPS`; `PIPELINE_ACCESS_GROUP` (unset = open
to every authenticated user) and `PIPELINE_ADMIN_GROUP` (unset = nobody) are read by
`src/lib/auth/apps.ts` and `src/lib/pipelineAdmin.ts`.

Two further groups are read from `.env.local` and only matter with a real identity provider.
Server-side token verification — `AUTH_PROVIDER`, `OKTA_ISSUER`, `OKTA_CLIENT_ID`,
`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `AUTH_GROUPS_CLAIM` — is read only when
`ALLOW_ANONYMOUS_API` is not `true`; an incomplete set is a 503 from the BFF, never an open door.
Browser-side login — `NEXT_PUBLIC_ENTRA_TENANT_ID`, `NEXT_PUBLIC_ENTRA_CLIENT_ID`,
`NEXT_PUBLIC_ENTRA_API_AUDIENCE`, `NEXT_PUBLIC_OKTA_ISSUER`, `NEXT_PUBLIC_OKTA_CLIENT_ID`,
`NEXT_PUBLIC_OKTA_REDIRECT_URI` — is active only when the provider named by
`NEXT_PUBLIC_AUTH_PROVIDER` has its client settings present. `chatbot-app/frontend/.env.example`
is the template for the whole console: the shared authorization block, then the recon variables,
then this app's.

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
rather than as a separate deployment. The recon app's routes, hooks, tabs and theme are untouched
and so are this app's; a shell around both adds what neither had.

**Shell.** `/` is a landing chooser with one card per app the signed-in viewer may open (a viewer
with exactly one app is sent straight into it). Inside an app a collapsible vertical rail on the
left switches between the apps the viewer has access to. The registry behind both is
`src/lib/auth/apps.ts`: id, label, page prefix (`/pipeline`), BFF prefix (`/api/pipeline`) and the
two group variable names per app. `/api/me` returns the `Viewer` — subject, groups, auth mode and
`apps.<id>.{access, admin}` — and the shell renders from that alone.

**Access groups.** Permissions come from the identity-provider group claim the BFF already verifies
(`AUTH_GROUPS_CLAIM`). Each app has an access group and an admin group; admins implicitly have
access. For this app: `PIPELINE_ACCESS_GROUP` and `PIPELINE_ADMIN_GROUP`; for recon,
`RECON_ACCESS_GROUP` and `RECON_ADMIN_GROUP`. An unset access group leaves that app open to every
authenticated user — the behaviour every deployment had before the shell — and an unset admin
group fails closed, as before. `src/proxy.ts` applies the access check to every `/api/pipeline/*`
request before the handler runs, and the admin-gated routes in §9 re-check the admin group for
themselves; the rail not showing an app is a courtesy on top of the gate. Local development uses
anonymous mode, which grants every app and both admin roles; `ANONYMOUS_GROUPS` previews a
restricted user (§11).

**Prefixed environment names.** Both BFFs run in one Next.js process, and the recon side already
owns `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` and `SKILLS_PREFIX` in the container's environment. The
pipeline BFF therefore reads `PIPELINE_ASSETS_BUCKET`, `PIPELINE_AGENT_MODEL_PARAM` and
`PIPELINE_SKILLS_PREFIX` first and the bare names only as a fallback for the standalone
`.env.local`. In the composed task the prefixed names must always be set: the bare ones exist and
are recon's, so a missing prefixed name would read recon's bucket, model parameter or skills
without any error. `PIPELINE_SAMPLES_PREFIX` is new and pipeline-only.

**Composed Terraform.** `infra/environments/recon` gains `enable_deal_pipeline` (default `false`).
When true it instantiates `infra/modules/deal-pipeline` beside `modules/frontend-ecs`, grants the
console's task role the bucket, table, memory, Lambda and SSM access this app needs, and passes the
task the §11 variables under the prefixed names. The module's resources, names and tags are the
ones in §3, so the standalone root and the composed one create the same things; only the caller
differs. `infra/environments/deal-pipeline` stays as the standalone root for running this app alone
against `npm run dev` with local state.

**Samples from S3 in the container.** The console image holds the built app and no `data/`, so
the simulated inbox cannot read `data/deal-emails` there. `infra/modules/deal-pipeline` seeds the
corpus to the pipeline bucket under `samples/<file>.json`, keeping the file names verbatim, and
`src/lib/pipeline/server/samples.ts` reads from the directory when it exists and from
`PIPELINE_SAMPLES_PREFIX` when it does not. Both sources yield the same `SampleEmail` shape and the
same ids (the file or object name without `.json`), so a sample picked from the dialog in either
environment reads back on the next request. Nothing is cached in either mode; a new sample on disk
shows up on the next open, and a new sample in S3 after the apply that seeded it.

**Decoupling.** The two apps share the auth module (`src/lib/auth/`, `src/lib/api-auth.ts`,
`src/lib/reauth.ts`), the `src/components/ui/` primitives and a few app-agnostic helpers, and
nothing else: no import crosses from `src/{app,components,lib,hooks}/*pipeline*` into `*recon*` or
back. Adding a third app is one entry in `APPS` plus its own route trees.

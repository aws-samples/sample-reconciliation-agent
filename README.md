# Reconciliation Workflow Agent

A sample agentic reconciliation platform. Work arrives as a structured dataset posted to an API.
Whatever matches deterministically clears without a model touching it. The rest goes to an agent, which classifies the break, runs whichever investigation skills apply — including searching for corresponding unstructured data (e.g. notice documents) —
and then either resolves the item itself or writes up a proposal for an analyst as a next step (e.g. an email draft).

It resolves on its own only when the computed evidence score clears an admin threshold and there is a
clean, provable action available. That gate does not live in the prompt: an AgentCore Policy
(Cedar) on the tools gateway checks the evidence score server-side, so a below-threshold model cannot
write even if it talks itself into trying.

The Tier-2 agent has two interchangeable backends, one is a container AgentCore Runtime
running an agent with the Strands SDK. The other is the managed AgentCore Harness, declared
in config with no orchestration code. Which Bedrock model either one invokes is configurable as well.
Alongside both, an evaluation pipeline scores sessions against analyst decisions as ground truth and surfaces prompt and tool recommendations in the Evals tab.
In addition AgentCore Memory and user feedback is used to extract generalizable lessons learned from each session.

## Two applications, one console

The console hosts two applications behind one shell, one sign-in and one identity provider — an
Amazon Cognito user pool this stack creates by default, or an external Okta / Entra tenant when
`auth_provider` names one (see [Authentication](#authentication)):

| App                      | Pages         | BFF               | What it does                                                                                                                                       |
| ------------------------ | ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trade Reconciliation** | `/recon/*`    | `/api/recon/*`    | Everything the rest of this README describes                                                                                                       |
| **Deal Pipeline**        | `/pipeline/*` | `/api/pipeline/*` | Turns new-issue deal emails into OMS staging records, reviewed before upload — contract and demo script in [`docs/deal-pipeline-design.md`](docs/deal-pipeline-design.md) |

`/` is the landing chooser: one card per app the signed-in viewer may open. Inside an app, a
collapsible vertical rail on the left switches between the apps the viewer has access to. An app the
viewer may not open is absent from the chooser and the rail, and every request to its BFF answers
403. Each app keeps its own routes, hooks, screens and theme; the shell adds the rail and the access
check and changes nothing inside either app.

**Per-app access from identity-provider groups.** Authorization reuses the group claim the BFF
already verifies (`AUTH_GROUPS_CLAIM`). Each app has an _access_ group ("may use it") and an _admin_
group ("may change how it behaves"), named by four environment variables on the console's task — or,
once the console layer described under [Console-wide configuration](#console-wide-configuration) is
configured, by values a console admin stored from the Settings screen, which overlay those same
names. The registry that reads them is `chatbot-app/frontend/src/lib/auth/apps.ts`; adding an app is
one entry there plus its own route trees.

| Variable                     | Grants                                                                                                                                                                                                                                                     | Unset means                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RECON_ACCESS_GROUP`         | may open Trade Reconciliation — and, because most recon writes check nothing further, may rewrite the agent's system prompt, skills and harness configs (see below)                                                                                        | open to every authenticated user, unless `REQUIRE_ACCESS_GROUPS=true`                                                                                                                                  |
| `RECON_ADMIN_GROUP`          | may change its configuration (auto-resolve threshold, agent backend, Tier-1, contacts, templates, workflow types), delete memory records and upload documents; implies access                                                                              | nobody can change configuration                                                                                                                                                                        |
| `PIPELINE_ACCESS_GROUP`      | may open Deal Pipeline: read, chat, simulate an email, reparse, propose a skill change                                                                                                                                                                     | open to every authenticated user, unless `REQUIRE_ACCESS_GROUPS=true`                                                                                                                                  |
| `PIPELINE_ADMIN_GROUP`       | may approve or reject deals, edit staged fields, write skills, the parser prompt and memories, decide proposals, change the model; implies access                                                                                                          | nobody can change the pipeline                                                                                                                                                                         |
| `REQUIRE_ACCESS_GROUPS`      | `true` (exact) makes a blank access group **deny** that app to everyone but its admins, instead of opening it. The composed deployment sets it whenever the pipeline is enabled                                                                            | a blank access group is open (the recon-only behaviour from before the shell)                                                                                                                          |
| `PIPELINE_ENABLED`           | `false` (exact) switches the Deal Pipeline app off in a running console: `/api/me` hides it and `/api/pipeline/*` answers 403. The ECS task sets it from `pipeline_enabled`                                                                                | enabled — local development needs nothing extra; recon has no such switch                                                                                                                              |
| `CONSOLE_ADMIN_GROUP`        | may edit console-wide settings on the Settings screen: every app's access and admin group, app enablement, the console defaults. **Environment-only** — the group that gates the Settings screen cannot be changed from it. Set from `console_admin_group` | nobody is a console admin: the Access, Applications and Defaults sections show their structure without values and cannot be edited. Anonymous local mode holds the group only when the variable is set |
| `CONSOLE_SETTINGS_PREFIX`    | SSM prefix (e.g. `/recon-dev/console`) under which the Settings screen stores its values and each user's preferences; stored values overlay the names above                                                                                                | the console layer is off: every setting reads from the environment as before, the Settings screen renders read-only with a note, preferences stay in the browser                                       |
| `CONSOLE_ORGANIZATION_LABEL` | environment fallback for the label shown under the console mark in the rail; a value stored from the Settings screen wins. Set from `console_organization_label`                                                                                           | `Agentic Operations Console`                                                                                                                                                                           |
| `CONSOLE_DEFAULT_MODEL_ID`   | environment fallback for the console default model id an app may copy (`<prefix>/defaults/model-id`); a stored value wins. Not set by Terraform, which seeds the parameter instead                                                                         | no console default: the pipeline Config tab offers no "Use console default"                                                                                                                            |

An unset **access** group keeps an app open to all authenticated users, which is exactly what a
recon-only deployment had before the shell existed. That default stops being safe the moment two
populations sign in through one OIDC client — a deal-desk user is then "authenticated" for
`/api/recon/*` too — so the composed deployment fails closed: `REQUIRE_ACCESS_GROUPS=true` is set
whenever the pipeline is enabled, and `infra/environments/recon` refuses to plan
`enable_deal_pipeline = true` while either `recon_access_group` or `pipeline_access_group` is blank.
An unset **admin** group fails closed, as it always has.

**Who creates the group depends on the provider, and so does what "unset" means.** With
`auth_provider = "okta"` or `"entra"` nothing in Terraform can create a group: an operator maintains
membership in a tenant Terraform cannot see, and the paragraph above is the whole story. With
`auth_provider = "cognito"` (the default) `infra/modules/console-auth` creates all five groups **in
the pool**, so an unset variable does not mean "no group" — the root resolves it to the pool's own
name for that group (`recon-users`, `recon-admins`, `deal-desk`, `deal-desk-admins`,
`console-admins`) and hands the console those same strings, which is why
`enable_deal_pipeline = true` is allowed to plan with both access variables blank there. It still
fails closed in the way that matters: every group is created **empty**, so nobody reaches either app
until an operator adds a user to one. `terraform output cognito_group_names` prints the five as the
console will check them, and `scripts/create_dev_users.py` populates them with five demonstration
accounts.

The access check runs in `src/proxy.ts` for every `/api/recon/*` and `/api/pipeline/*` request. What
happens after it differs between the apps. **Every Deal Pipeline write route re-checks
`PIPELINE_ADMIN_GROUP`** (§9 of the design doc lists them). **Trade Reconciliation's admin group
gates only part of its writes**: `config/*` (threshold, backend, Tier-1, contacts, templates,
workflow types), `memory` DELETE and `uploads`; the case-decision routes (`cases/[id]`, its `draft`)
verify the acting user. The remaining recon writes — `system-prompt`, `skills` (create, edit,
delete), `harness/configs` and its `deploy`, `evals/batch`, `evals/recommendations`,
`idp-extractions` and the bulk `cases` update — carry no admin check at all: anyone the proxy admits
may call them. `RECON_ACCESS_GROUP` is therefore the real boundary around what the reconciliation
agent does, and an app hidden from the rail is a courtesy on top of the proxy, not the gate.

**Local development** runs without an identity provider. `ALLOW_ANONYMOUS_API=true` in
`chatbot-app/frontend/.env.local` skips token verification and grants every app and both admin roles
to the single `anonymous` subject. The BFF honours two older names for the same switch,
`RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API` (each app's pre-shell spelling); any
one of the three being exactly `true` opens **both** BFFs, so an audit of a task definition must
look for all three, and none of them belongs in a deployment. To preview what a restricted user
sees, set `ANONYMOUS_GROUPS` to
the comma-separated groups that subject should carry instead — for example
`RECON_ACCESS_GROUP=recon-analysts`, `PIPELINE_ACCESS_GROUP=deal-desk` and
`ANONYMOUS_GROUPS=deal-desk` shows the Deal Pipeline app alone, with no admin controls.
`chatbot-app/frontend/.env.example` is the template for both apps, and its Deal Pipeline block uses
the `PIPELINE_`-prefixed names below.

**Deploying.** `infra/environments/recon` is the console's root. Setting `enable_deal_pipeline = true`
there composes `infra/modules/deal-pipeline` (one bucket, three tables, two AgentCore Memories, two
Lambdas) into the same apply, grants the console's task role access to those resources, seeds the
sample-email corpus to the pipeline bucket under `samples/` (the container ships no `data/`, so the
BFF reads samples from S3 there and from disk under `next dev`), and hands the task the pipeline's
variables — under `PIPELINE_`-prefixed names where a bare name would collide with recon's in the shared
process: `PIPELINE_ASSETS_BUCKET`, `PIPELINE_AGENT_MODEL_PARAM`, `PIPELINE_SKILLS_PREFIX`,
`PIPELINE_SAMPLES_PREFIX`. The pipeline BFF reads **only** those prefixed names — there is no fallback
to `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` or `SKILLS_PREFIX`, because in the shared container those are
recon's and a fallback would have read recon's bucket without an error. The same apply sets
`REQUIRE_ACCESS_GROUPS=true` and `PIPELINE_ENABLED=true` on the task, and the plan is refused while
either access group is blank. The pipeline's resources come out under the `<name_prefix>-pipeline`
prefix (e.g. `recon-dev-pipeline-emails`, `/recon-dev-pipeline/agent-model-id`). With the flag off
(the default) the deployment is the recon app alone, `PIPELINE_ENABLED=false` is set, and the Deal
Pipeline entry never appears. There is one Terraform root; a laptop runs either app against a
deployment by rendering `.env.local` with `terraform output -raw frontend_env_local` in
`infra/environments/recon`. The five-step demo is §12 of the design doc.

### Console-wide configuration

Everything above is **per-app** configuration, and it stays exactly where it is: the Trade
Reconciliation Config tab (auto-resolve threshold, agent backend, Tier-1, model selection, contacts,
templates, workflow types) and the Deal Pipeline Config tab (parser model) each read and write their
own SSM parameters, and neither can see the other's. Above both sits a thin **console-wide** layer for
what belongs to the console as a whole rather than to one app: who may reach which app, which apps
are deployed, defaults an app may choose to copy, and each user's own preferences. Its contract is
`chatbot-app/frontend/src/lib/console/types.ts`, and §14 of
[`docs/deal-pipeline-design.md`](docs/deal-pipeline-design.md) is the design.

**The Settings screen** is `/console/settings` (`/console` redirects there), reached from the Settings
entry in the rail's footer, in five sections addressed by `?tab=`:

| Tab              | Values readable by | What it holds                                                                                                                                                                                                                                             |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**       | console admins     | The access group and admin group of each app, a source chip beside each. Everyone else sees the structure — which variable names each group, per app — without the values                                                                                 |
| **Applications** | console admins     | On/off for the apps that have a switch: today only Deal Pipeline; Trade Reconciliation has no switch and is always part of the console                                                                                                                    |
| **Defaults**     | console admins     | The Bedrock model or inference-profile id an app may copy, and the organization label shown under the console mark in the rail                                                                                                                            |
| **Users**        | every user         | Who the console takes you for (subject, groups, per-app access, console admin or not) and, for console admins, a **check access** tool: which apps a hypothetical user holding a given set of groups would see, and whether they would be a console admin |
| **Preferences**  | every user         | Your own: the app to open from `/` when you may use several, whether the rail starts collapsed, and the theme (`system`, `light` or `dark`)                                                                                                               |

A console admin lands on Access; everyone else on Preferences. Editing needs both a console admin
(`CONSOLE_ADMIN_GROUP`) and a configured layer (`CONSOLE_SETTINGS_PREFIX`); otherwise the admin
sections carry a note saying which of the two is missing. Beside every console-wide field is a
**source chip** — `stored`, `env` or `default` — so an operator can tell a value that came from the
Settings screen from one the task definition supplies, and see what the field would fall back to if
the stored value were cleared. Saving sends only the fields that changed, so a value that was merely
displayed from the environment never silently becomes a stored one.

**Storage.** One SSM String parameter per setting under `CONSOLE_SETTINGS_PREFIX`. The Terraform
root sets `/<name_prefix>/console` (`/recon-dev/console`), inside the `/<name_prefix>/*` path the
task role already uses for the two Config tabs:

| Parameter                                              | Holds                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `<prefix>/access/<appId>/access-group`                 | IdP group that may use the app (`appId` is `recon` or `pipeline`); absent means "see env / default" |
| `<prefix>/access/<appId>/admin-group`                  | IdP group that administers the app                                                                  |
| `<prefix>/apps/<appId>/enabled`                        | `true` or `false`; only for apps with a switch (`pipeline`)                                         |
| `<prefix>/defaults/model-id`                           | Bedrock model or inference-profile id an app may copy                                               |
| `<prefix>/defaults/organization-label`                 | Label shown under the console mark in the rail                                                      |
| `<prefix>/prefs/<sha256(subject) hex, first 32 chars>` | One user's preferences, as JSON                                                                     |
| `<prefix>/meta/updated`                                | `{at, by}` of the last save from the Settings screen, shown as its "Last saved" line                |

**Precedence: stored → env → default.** The stored layer is an _overlay_ on the same environment
names the registry already reads — `RECON_ACCESS_GROUP`, `RECON_ADMIN_GROUP`, `PIPELINE_ACCESS_GROUP`,
`PIPELINE_ADMIN_GROUP`, `PIPELINE_ENABLED` — plus `CONSOLE_ORGANIZATION_LABEL` and
`CONSOLE_DEFAULT_MODEL_ID` for the two defaults. A stored value replaces the environment value before
`resolveAppAccess`, the proxy's access check and the two admin helpers read it, so none of them
changed apart from receiving the overlaid environment; an absent parameter leaves the environment
value in place, and the environment's own unset case falls through to the default the table above
describes. Clearing a field from the UI deletes the parameter (SSM has no empty value), so the
setting falls back to env — never to "open" unless the environment was open. Each process caches the
stored layer for **30 seconds**: the admin who saved sees the result at once (the save drops that
process's cache), while the proxy — a separate bundle with its own cache, even on the same task — and
every other task pick the change up within about half a minute. When Parameter Store cannot be read
(throttling, a missing grant after a deploy) the layer resolves from the environment alone for one
30-second window and logs it once, so a Parameter Store hiccup cannot become a console-wide outage.
The cost is stated plainly: for that window a restriction that exists only in the stored layer is not
enforced, which is why a deployment that cannot accept it names the group in the environment as well
and lets the stored value merely override it. The Settings screen itself never fails open — an admin
who cannot read the parameters sees the error, not a screen claiming every value comes from the
environment — and the two Config tabs' own parameters are not cached and are unaffected.

**Three switches are environment-only** and can never be changed from the UI. The Settings screen
reports them read-only, for transparency: `REQUIRE_ACCESS_GROUPS`, `ALLOW_ANONYMOUS_API` (with its
pre-shell names `RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API`) and
`CONSOLE_ADMIN_GROUP` itself. A console admin may rename which group opens an app; they must not be
able to widen access past what the deployment allows — turn a fail-closed blank group into an open
one, or token verification into anonymous mode — and they must not be able to make anyone (including
themselves) a console admin. Keeping those three out of the stored layer is what makes an edit from
the UI unable to escalate beyond the deployment's own settings. `CONSOLE_ADMIN_GROUP` fails closed like
the two app admin groups: unset means nobody is a console admin — the Access, Applications and
Defaults sections show their structure without values and cannot be edited — until an operator names
a group in `console_admin_group` and the identity provider releases the claim. Anonymous local mode
holds every configured group, so it is a console admin exactly when the variable is set
(`.env.example` sets `console-admins`).

**Per-user preferences** (default app, rail collapsed, theme) are stored one parameter per user under
`<prefix>/prefs/`, keyed by the first 32 hex characters of the SHA-256 of the token subject rather than
by the subject itself: an OIDC subject can contain characters a parameter name refuses, and a listing
that spelled out every user's identifier would be a roster. `GET`/`PUT /api/console/preferences` read
and write the caller's own row only — the subject comes from the verified token, never from the body.
When the layer is unconfigured `GET` answers `{}`, `PUT` answers 409, and preferences fall back to the
browser (`localStorage`, the `shell:rail:collapsed` key the rail used before). Even when configured
the browser value is used first, so the rail never pops between states on the first paint; the stored
value then wins once per load, the rail's own collapse button writes it back so a click outlives the
browser, and the stored theme is applied once per load. A `defaultApp` sends `/` straight into that
app when the viewer may use several and still has access to it; a viewer with exactly one app goes
there regardless.

**"Use console default"** is the one place an app takes a value from the layer, and it is a copy, not
a link. `GET /api/pipeline/config` reports the console's `defaults/model-id` beside the pipeline's own
selection, so the Deal Pipeline Config tab can offer **Use console default** next to its
family/endpoint presets; choosing it is the same admin-gated `PUT` of the pipeline's own parameter
with that id, and the parser Lambda keeps reading that parameter alone. Nothing outside the pipeline
BFF learns the console default exists, the panel says so when the console default is not an id the
pipeline offers, and a later change to the console default does not move the pipeline until someone
chooses it again. The Trade Reconciliation Config tab is unchanged — its model selection stays its
own — and nothing in the console layer writes either app's parameters.

**Terraform.** `infra/modules/console-settings` creates the parameters; both roots instantiate it at
`/<name_prefix>/console`. It seeds all seven settings from variables the root already has — the four
groups from `recon_access_group` / `recon_admin_group` / `pipeline_access_group` /
`pipeline_admin_group`, the pipeline switch from `enable_deal_pipeline`, the default model id from
`pipeline_agent_model_id`, and the label from the new `console_organization_label` (default
`Agentic Operations Console`) — so on day one the stored layer and the task environment agree and
every seeded field reads `stored`. A blank seed creates **no** parameter (a placeholder would be read
as a stored value that outranks the environment), so the UI creates it on first save. Seeded
parameters are **created, never reverted**: the module ignores changes to the value, so a later apply
leaves what a console admin changed from the Settings screen alone and the next CI run cannot undo an
operator's edit. Two consequences worth knowing: Terraform still manages the parameter's _existence_,
so clearing a value in the UI while its seed is still set means the next apply re-creates it from the
seed — clearing for good is "clear in the UI, then blank the seed" — and a parameter the UI created
first cannot later be adopted by giving its seed a value (the create fails rather than overwrite the
UI's value; import it, or leave the seed blank). The new `console_admin_group` (default `""`, fail
closed) reaches the task as `CONSOLE_ADMIN_GROUP`, `console_organization_label` as
`CONSOLE_ORGANIZATION_LABEL`, and the module's `prefix` output as `CONSOLE_SETTINGS_PREFIX`, so the
seeder, the reader and the task role's grant (`ssm:GetParameter`, `GetParameters`,
`GetParametersByPath`, `PutParameter`, `DeleteParameter` on `parameter<prefix>` and
`parameter<prefix>/*`) cannot drift apart. The plan-only module tests are
`infra/modules/console-settings/tests/` and `infra/modules/frontend-ecs/tests/console_settings.tftest.hcl`.
The recon root's `frontend_env_local` output renders the three `CONSOLE_*` names for a laptop.

---

## Solution Architecture

![Solution Architecture](assets/solution-architecture.svg)

_Full interactive version: [`assets/Solution Architecture.html`](assets/Solution%20Architecture.html)_

![Operator console — every screen, in nav order](assets/img/demo.gif)

The architecture has three planes:

| Plane               | Purpose                                                                                                                                                    | Key services                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Ingestion**       | Email/document intake → unique event id → raw storage → classification → field extraction (Bedrock LLM) → schema validation → per-field confidence scoring | IDP pipeline (Lambda, S3, DynamoDB)                                                                         |
| **Application**     | Human-in-the-loop review frontend + backend API; agent runtime for the Reconciliation Agent                                                                | Frontend (React/Next.js), ECS/ALB, Backend API, Step Functions (Tier-2 dispatch), AgentCore Runtime/Harness |
| **Shared services** | Tool access, memory, identity, policy, observability, evaluation for all agents; LLM access                                                                | AgentCore Gateway, Memory, Identity, Policy, Evaluation; Bedrock Knowledge Base; Bedrock foundation models  |

### High-level architecture components

| Concern            | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points       | The IDP post-processing hook Lambda (`recon-dev-idp-hook`, invoked by recon's **own** EventBridge rule when an IDP document-processing execution reaches a terminal status), and an intake HTTP API (API Gateway + an OIDC JWT authorizer on the same identity provider the console signs in through — the Cognito user pool this stack creates by default, or the Okta/Entra tenant when one is named) for structured datasets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Item / case stores | Five DynamoDB tables: `recon-dev-items` (canonical `ReconItem` inputs — **the only stream-enabled table**, which is what makes writing an item the way to open a case), `recon-dev-cases` (case lifecycle, status GSI), `recon-dev-audit` (append-only status-transition log), `recon-dev-lessons` (analyst decisions: approval, correction, auto-resolution, one row per item+trigger), and `recon-dev-notices` (extracted documents as **evidence**). Operator configuration lives in three more: contacts, email templates and workflow types                                                                                                                                                                                                                                                                                                                                                                                                    |
| Deterministic tier | A Tier-1 Lambda consuming the items stream. Items match within tolerance and items are looked up in a mocked general ledger (Athena over S3) and auto-clear only on an unambiguous attribute match: account name, entry-type direction, and amount within tolerance (toggleable via SSM or the Config tab)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tier-2 dispatch    | A Step Functions state machine (`recon-dev-tier2`, STANDARD) on an EventBridge schedule. It collects `PENDING` cases oldest-first off the status GSI to S3, then investigates them in a Distributed `Map` whose **`MaxConcurrency` is the Bedrock token budget** — the escalating consumer dispatches nothing. Each child claims its case, then hands the runtime a Step Functions **task token** so the dispatcher returns in ~1s instead of blocking for the investigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Agent              | Two interchangeable backends selected by the `agent_backend` SSM parameter: an AgentCore Runtime container (Strands `Agent` agentic loop), or the managed AgentCore Harness (config-declared), with the model each one invokes selected by a second parameter (`agent-model-id`), read per invocation. Skills and the system prompt are live from S3, with a ~60 s cache on the runtime and per-session on the harness. Two AgentCore gateways (AWS_IAM/SigV4): the egress tools gateway (9 targets, 6 of them conditional — one is a managed `bedrock-knowledge-bases` **connector** target, the rest Lambda/OpenAPI) with the Cedar Policy confidence gate, and an ingress agent gateway fronting the runtime (one `http/agentcoreRuntime` target of its own). AgentCore Memory holds the `lessons_learned` semantic strategy, and a fully managed Bedrock Knowledge Base holds the guidance corpus, queried with agent-supplied metadata filters |
| Evaluation         | AgentCore Online Evaluation (a custom analyst-agreement evaluator plus 3 builtins) over harness OTel traces, on-demand batch re-scores, managed recommendations, and a versioned harness-config store (immutable S3 docs + SSM pointer). All of it surfaces in the Evals tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Frontend           | Next.js on ECS Fargate behind an ALB and CloudFront, with a WAFv2 web ACL (`AWSManagedRulesCommonRuleSet`) on the distribution, which is the single internet entry point. Amazon Cognito hosted-UI login with PKCE by default (`auth_provider`, swappable to Okta or Entra) and same-origin BFF routes (`/api/recon/*`, plus `/api/pipeline/*` when the Deal Pipeline app is enabled) running under the task role, gated per app by identity-provider groups (see "Two applications, one console")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Notifications      | Microsoft Graph is the only channel (app-only, from the shared mailbox), reached through the egress gateway's OpenAPI target. It carries resolution emails on approve/auto-resolve (`cases/notify.py` plus the frontend BFF calling `sendSharedMailboxMail` through the gateway with SigV4), counterparty email sent by the BFF from an analyst-approved draft, and mailbox reads (`listSharedMailboxMessages`, reached only through the `search_correspondence` wrapper). No agent holds a send tool on either backend: the model writes the counterparty message into its proposal and a human approves a specific revision of it. Nothing stores an address: a draft and a resolution notice both name a contact id, and the address is read from the contacts table at the moment of sending, so deactivating a contact stops mail to them even if a draft was already approved. Sends are gated at the gateway REQUEST interceptor.            |
| IaC                | Terraform (`infra/`) with S3-backed state. The AgentCore Harness lifecycle is an `aws_cloudformation_stack` (`infra/modules/recon-agent-harness`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Intelligent Document Processing (IDP) decoupling:** One channel reaches the independently-deployed
IDP solution and no other: the completion event recon's own EventBridge rule reads. The IDP MCP
gateway target and its `get_results` tool are retired — notice search is the single path to document
evidence, which is why the agent has no coupling surface to the pipeline at all. IDP storage is
touched in three sanctioned places, none of them the agent: the hook reads the
output bucket at ingest, to copy extracted field values and page images into the notice; the console
streams a document's raw bytes out of the input bucket for the Documents tab, rather than duplicating
customer financial documents into recon storage; and an extraction upload is put into that same input
bucket. The runtime and the agent never touch IDP storage at all.

---

## Repository layout

```
backend/                Python 3.12 Lambda handlers
  recon_core/           Shared domain: schema, cases, status, confidence, auto_resolve,
                        lessons_recall, memory (AgentCore record retrieval, used by both apps),
                        ddb_update + s3_text (helpers both apps' Lambdas import),
                        errors (ToolDenied), email_policy + templating (the
                        authority on which recipient and which wording a send may carry —
                        the BFF, the interceptor and the browser all defer to it),
                        skills_s3, prompt_source (shared-core + harness-contract
                        composition), session (the one owner of AgentCore session-id
                        derivation), otel_client (client-side spans, baggage, trace
                        propagation)
  tier1/                DynamoDB stream consumer (opens the case PENDING; dispatches nothing) plus
                        the BLOCKING agent-worker, still used for the harness backend and for the
                        frontend's single-case Retry. Two independent switches, not a flat three-way
                        choice: `harness` vs `runtime` (SSM-backed), and — for `runtime` only —
                        ingress vs direct transport to the same container
  tier2_dispatch/       Async dispatch for the map run: a dispatcher that hands the agent a Step
                        Functions task token and returns in ~1s, a collector that materialises the
                        PENDING list to S3 (a Distributed Map's ItemReader reads S3 only), and the
                        two guarded case writes (claim / mark-failed)
  harness_agent/        Managed-Harness backend: worker, stream, intake (proposal validation +
                        reference derivation), prompting, session, config_store
  gl_tool/              General-ledger read + set_draw_status write (status allowlist only;
                        threshold via Cedar Policy, provenance via the gateway interceptor)
  status_tool/          recon-status gateway target: recon_update_status (platform-only,
                        state-machine-guarded + audited case-status writes)
  gateway_interceptor/  Gateway REQUEST interceptor: set_draw_status provenance +
                        recon_update_status transition re-check + the sendSharedMailboxMail
                        email gate — token + sendPurpose, where `notification` may only
                        address an active internal_notification contact and `counterparty`
                        must match the draft approved on the case at that revision
                        (log/enforce modes), plus OData argument normalization on the
                        listSharedMailboxMessages read
  notice_tool/          search_notices target over the notices table; `_matches` is the single choke
                        point that excludes tracking-only rows from the agent's evidence
  correspondence_tool/  correspondence-search gateway target: search_correspondence(query, top)
                        — sanitizes the model's arguments into Graph's OData form ($search
                        double-quoted, $top an integer) and re-enters this gateway to call
                        listSharedMailboxMessages, so the Graph credential stays in the vault
  eval_agreement/       Analyst-agreement custom evaluator Lambda
  intake/               Intake API handler
  idp_hook/             IDP post-processing hook + mapper + explainability (aggregates IDP's
                        per-field confidences into the notice's extraction_confidence) + tracking
                        (the pipeline's own run snapshot embedded on the row). A terminal outcome
                        that produced no notice recon could map still gets a tracking-only row
  email_preprocess/     Called by the BFF upload route per .msg/.eml: derives body + attachments
                        into the assets bucket and returns a manifest, so the bytes never pass
                        through the web task. A refusable email returns a reason, not a raise
  kb_ingest/            Knowledge-base ingestion for operator uploads: S3 → SQS delay queue at
                        reserved concurrency 1, because StartIngestionJob fails while a job is
                        in flight. Confirms a key by listing documents, never by job statistics
  cases/                Resolution-email helper; no cases BFF — status writes go through the tool
  contacts/             Recipient list + email templates; the agent-facing read projects addresses away
  skills_api/           Skills BFF: read-only (`GET /skills`); the Skills tab's writes are BFF routes
  lessons_api/          Lessons BFF
  deal_pipeline/        Deal Pipeline: parser_handler (Bedrock Converse tool loop with
                        lookup_security_master + stage_deal), oms_upload_handler (mock OMS
                        validator), oms_schema + oms_fields.json (the staging-CSV contract),
                        security_master, skills_loader, memory_recall, coerce

agent-blueprint/
  recon-agent/          AgentCore Runtime container: agent.py, strands_investigator.py, llm.py,
                        classifier.py, proposal.py, gateway_mcp.py, skills_loader.py,
                        skills/*.md, system-prompt.md, Dockerfile
  recon-agent-harness/  Harness blueprint: harness_config.py (tools/schema), system-prompt.md
  deal-pipeline-agent/  Deal Pipeline seed, no code: skills/*/SKILL.md (deal-parsing,
                        news-alert-format, bank-notice-format, oms-csv-format) and
                        prompts/{parser,assistant}-system.md, seeded to the pipeline bucket

chatbot-app/
  frontend/             Next.js console: the shell (/ landing chooser, the app rail, /api/me,
                        src/lib/auth/apps.ts, the console-wide Settings screen and /api/console/*
                        behind it, contract in src/lib/console/types.ts) hosting two apps —
                        /recon/* pages + /api/recon/*
                        BFF, and /pipeline/* pages + /api/pipeline/* BFF (server libs under
                        src/lib/pipeline/server). Other api/ route groups are scaffolding
                        inherited with the fork; 9 of them are non-functional in this
                        deployment and fail loudly naming the missing env var
                        (src/lib/deployment-env.ts)

docs/
  deal-pipeline-design.md  The Deal Pipeline contract: flow, data model, OMS rules, BFF routes,
                        environment, console integration, demo script

infra/
  modules/              Terraform modules: foundation, notice-store, contact-store,
                        workflow-types, upload-audit, intake, tier1, idp-hook, email-preprocess,
                        kb-ingest-trigger, recon-agent, recon-agent-harness, agent-evals, gl-mock,
                        api, frontend-ecs, lambda-package, lambda-logs, deploy-actions, network,
                        observability, microsoft-graph-obo, tier2-dispatch, agentcore-memory,
                        seeded-object, deal-pipeline (bucket, tables, memories, parser + OMS
                        Lambdas), console-settings (the console-wide layer's seeded SSM parameters),
                        console-auth (the console's OWN identity provider: a Cognito user pool, its
                        hosted UI, one public PKCE app client and the five console groups —
                        instantiated only when auth_provider = "cognito", which is the default.
                        Deliberately NOT in foundation; see "Authentication")
  environments/recon/   The console's root, and the only one (S3-backed state via a partial
                        backend config); enable_deal_pipeline composes modules/deal-pipeline
                        into it
  bootstrap/            Terraform-state bucket bootstrap (local state; import-first — see
                        "Getting Started" step 1)
  scripts/              deploy-recon.sh, push_editable_seeds.py, gen_harness_config_json.py,
                        reset_runtime_data.py, verify_harness_surface.py,
                        evals-provisioning-notes.md

data/                   Synthetic sample documents, mocked general-ledger CSV, the kb-seed
                        guidance corpus and the tracked IDP extraction config (recon);
                        deal-emails/ (the pipeline's seven fictional emails, file name = corpus
                        id) and security-master/ (issuers + canonical counterparties)
tests/                  pytest (moto-mocked AWS), one directory per backend package incl.
                        tests/deal_pipeline; frontend: chatbot-app/frontend/__tests__
assets/                 Architecture diagrams (SVG/HTML), screenshots, CUJ walkthrough +
                        template, and the detail pages this README links out to (ci-cd.md,
                        agent-evaluation.md, private-vpc-deployment.md)

.github/workflows/      GitHub Actions: CI only (the public remote has no AWS account)
.gitlab-ci.yml          GitLab: the same CI, plus plan + apply on main — see assets/ci-cd.md
requirements-dev.txt    Test-only Python deps (pytest, moto, responses, ruff)
```

## Tech stack

| Layer    | Stack                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend  | Python 3.12, `strands-agents==1.54.0`, `bedrock-agentcore==1.22.0`, `boto3==1.43.89`, `pydantic==2.13.4`, `aws-opentelemetry-distro==0.19.0` (runtime container) |
| Frontend | Next.js 16, React 18, Tailwind CSS, Radix UI, `@aws-sdk/client-bedrock-agentcore`; sign-in is Cognito hosted UI + PKCE with **no SDK** (`src/lib/auth/cognito-pkce.ts`, platform `crypto` + `fetch`), or MSAL / `@okta/okta-auth-js` when Entra or Okta is selected |
| IaC      | Terraform (AWS provider `>= 6.62.0, < 7.0.0` — 6.62.0 is the floor for three AgentCore schema features this stack uses), S3 backend                              |
| Agent    | Amazon Bedrock AgentCore (Runtime, Harness, Gateway, Memory, Policy, Evaluation, Identity)                                                                       |
| LLMs     | Claude Sonnet 5 (default for both the runtime and harness backends; selectable per backend)                                                                      |
| Testing  | pytest + moto (backend), vitest + testing-library (frontend)                                                                                                     |

## Getting Started

You need a clone of this repo, Terraform `>= 1.11`, AWS credentials for the target account, and the
toolchain the five `local-exec` provisioners shell out to during the apply: a POSIX shell, `zip`,
`rsync`, the AWS CLI, and `python3` with `pip`. A laptop that already has the AWS CLI and Python has all of
it but possibly `rsync` — `infra/modules/lambda-package/stage.sh:66` runs `rsync -a --delete` to build
the Lambda staging directory, and a minimal CI image or container build agent often does not ship it.
Install it before the first apply rather than after: that provisioner runs *during* the apply, so a
missing binary surfaces once Terraform has already begun creating resources.

**No external identity provider is needed** — sign-in is an Amazon Cognito user pool this
stack creates (`auth_provider = "cognito"`, the default), so the console can be opened on a first
apply; Okta and Entra remain first-class alternatives and are configured exactly as they were.

Steps 1 to 3 are one-time setup for a fresh account or a fresh checkout; from then on step 3 is the
whole deployment. Steps 4 and 5 are the two things the apply cannot do for you — create the people, and
create the content — and skipping either leaves a console that looks broken but is not.

**The whole path, from a clone to a browser you are signed in to,** using the cheap profile so nothing
hourly is created and nothing is built for the edge. Each line is one of the steps below; the numbers
are where to read why:

```bash
# 1  once per account
cd infra/bootstrap && terraform init && terraform apply

# 2  once per checkout: backend.hcl (the state bucket) + terraform.tfvars (five values)
cd ../environments/recon
cp backend.hcl.example backend.hcl && cp terraform.tfvars.example terraform.tfvars
# ... edit both. name_prefix and cognito_hosted_ui_prefix must be GLOBALLY unique — see step 2.
# ... and add the five cheap-profile flags from "The cheap development profile" below.

# 3  deploy. Re-run it if the gateway targets or Cedar policies fail the first time — see step 3.
../../scripts/deploy-recon.sh plan && ../../scripts/deploy-recon.sh apply

# 4  create the five demonstration operators in the pool the apply just made
python3 ../../../scripts/create_dev_users.py --dry-run          # then without --dry-run

# 5  give recon a queue: six items Tier-1 will decide six different ways
python3 ../../../scripts/seed_recon_demo_items.py --dry-run     # then without --dry-run

# 6..8 render the laptop's environment, then run the console
terraform output -raw frontend_env_local > ../../../chatbot-app/frontend/.env.local
cd ../../../chatbot-app/frontend && npm ci && npm run dev       # http://localhost:3000
```

That last block is the cheap profile's own recipe, described with its caveats under
[The cheap development profile](#the-cheap-development-profile) — including the one that surprises
people: the rendered `.env.local` sets `ALLOW_ANONYMOUS_API=true`, so by default the laptop does **not**
sign in at all and you see the console as a single anonymous subject holding every configured group.
Exercising the real Cognito redirect from a laptop is three lines of that file, and the section says
which. With the frontend tier left on (the default), skip the last block: the apply builds and serves
the console itself, and `terraform output frontend_url` is the address.

### 1. Bootstrap the Terraform state bucket (once per account)

`infra/bootstrap` creates the S3 bucket every environment stores its state in. It keeps local state,
because it cannot use the bucket it is about to create as its own backend.

In a fresh account, `terraform init && terraform apply` there is all it takes. If the bucket already
exists — it does in the dev account, where `recon-dev-tfstate-<account_id>` was created out-of-band
before it was expressed as code — a plain apply fails with `BucketAlreadyOwnedByYou` instead of
adopting it. Import the four resources first:

```bash
cd infra/bootstrap && terraform init
BUCKET="recon-dev-tfstate-$(aws sts get-caller-identity --profile <your-profile> --query Account --output text)"
terraform import aws_s3_bucket.tfstate                                      "$BUCKET"
terraform import aws_s3_bucket_versioning.tfstate                           "$BUCKET"
terraform import aws_s3_bucket_server_side_encryption_configuration.tfstate "$BUCKET"
terraform import aws_s3_bucket_public_access_block.tfstate                  "$BUCKET"
terraform plan   # expect "No changes" — the live bucket already has all four settings
```

Skipping the import is not free: an unimported bucket has no Terraform source, so drift in its
versioning, encryption or public-access settings appears in no plan.

### 2. Create the two local config files

Neither file is committed, because both carry the AWS account ID — the state bucket name embeds it,
and a `backend` block cannot read variables, which is why the bucket name arrives through a separate
`-backend-config` file.

```bash
cd infra/environments/recon
cp backend.hcl.example backend.hcl            # then set the state bucket name from step 1
cp terraform.tfvars.example terraform.tfvars  # then fill in the required values
```

Two variables declare no usable default, so both plan and apply stop until they are set:

- `otel_layer_account` — AWS's own public layer-publisher account rather than a secret. It lives in
  tfvars only because the repo's pre-push guard rejects any 12-digit run in a committed file.
- `cognito_hosted_ui_prefix` — the sign-in host becomes
  `<prefix>.auth.<region>.amazoncognito.com`, and that name is **globally unique across every AWS
  account**, so it cannot be derived from `name_prefix` without colliding with the next person who
  deploys this sample. Add entropy (`recon-dev-login-7f3a`). It may not contain `aws`, `amazon` or
  `cognito` — AWS documents the rule as "you cannot use keywords aws, amazon, or cognito for domain
  prefix" ([AWS Security
  Blog](https://aws.amazon.com/blogs/security/how-to-set-up-amazon-cognito-for-federated-authentication-using-azure-ad/)),
  and `infra/modules/console-auth/variables.tf:19-26` turns it into a plan-time error rather than a
  mid-apply `InvalidParameterException`. Required only when
  `auth_provider = "cognito"`; an Okta or Entra deployment never sets it.

⚠️ **A third value has a default that you must nevertheless change: `name_prefix`.** It defaults to
`recon-dev` in both `variables.tf` and `terraform.tfvars.example`, and **that default is already
taken.** `infra/modules/foundation` names two buckets `${name_prefix}-raw` and `${name_prefix}-assets`
with no account suffix (`modules/foundation/main.tf:221,226`), and S3 bucket names are global. Both
`recon-dev-raw` and `recon-dev-assets` exist right now: an unauthenticated `HEAD` on each returns
`403`, not `404`, which is S3 saying the name is in use by a bucket you may not read. Unless the
account you are deploying into is the one that owns them, `CreateBucket` answers `BucketAlreadyExists`
and the first apply stops there
([CreateBucket errors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html)). Every
other name in the stack is either
prefix-derived within your own account or already carries the account id, so a `name_prefix` nobody
else has claimed is enough: pick something with entropy in it (`recon-<team>-<4 hex>`) and reuse the
same value for `cognito_hosted_ui_prefix`'s stem. The two buckets are the only globally-unique names
this repo composes without an account suffix; a recommended fix is at the end of
[Installing into an existing, governed AWS account](#installing-into-an-existing-governed-aws-account).

A minimal `terraform.tfvars` for a first deployment is five lines — everything else has a working
default:

```hcl
region                   = "us-east-1"           # see the region note below; not freely changeable
name_prefix              = "recon-amx-7f3a"      # globally unique, because of the two buckets above
otel_layer_account       = "<12-digit-account-id>"
cognito_hosted_ui_prefix = "recon-amx-login-7f3a" # globally unique; no "aws"/"amazon"/"cognito"
console_admin_group      = "console-admins"       # else nobody may edit console-wide settings
```

`region` is documented as an ordinary variable, and for this stack it is not: a `CLOUDFRONT`-scoped WAF
web ACL has to be created in us-east-1 and a `lifecycle.precondition` in `infra/modules/frontend-ecs`
asserts `var.region == "us-east-1"`, and two module defaults hardcode the availability zones
`us-east-1a` / `us-east-1b`. Deploy elsewhere and you are editing modules, not tfvars —
[the governed-account section](#3-region-availability) has the detail.

See [Prerequisites & configuration](#prerequisites--configuration) for every variable.

### 3. Deploy

```bash
./infra/scripts/deploy-recon.sh plan
./infra/scripts/deploy-recon.sh apply
```

The script changes into `infra/environments/recon`, refuses to run at all without `backend.hcl`, and
wraps `terraform init -backend-config=backend.hcl` plus plan, apply or destroy with `-input=false`. By
hand it is `terraform init -backend-config=backend.hcl && terraform apply`.

One apply deploys everything. It packages the Lambdas, has CodeBuild build and push the agent
container and the frontend image (the build driver blocks until the push succeeds, before the
AgentCore Runtime is created), provisions the managed Harness (an `aws_cloudformation_stack`),
attaches the Cedar Policy, seeds the skills, system prompts and KB corpus to S3,
wires the CloudFront domain and agent runtime ARN through Terraform's dependency graph, and rolls the
ECS service. No manual build step and nothing to run in a second pass. Both container builds sit on the
apply's critical path rather than beside it: the frontend driver polls `codebuild batch-get-builds` every
10 seconds for up to 180 iterations — 30 minutes — before it gives up
(`infra/modules/frontend-ecs/main.tf:334-345`), so expect the apply to spend most of its time waiting
there.

⚠️ **Expect to re-run the apply once on a first install, and do not debug it before you do.** The
AgentCore gateway targets and the Cedar policies race the gateway's own tool surface: on a first apply
into an empty account they can fail once — the gateway exists, its tool list is not yet readable, and
the target or policy creation that depends on it errors — and the identical apply succeeds on the next
run with no change to any input. `terraform apply` again. Nothing is lost, because everything that
already succeeded is in state. The consequence for automation is the part worth designing around: CI
that runs `terraform apply` exactly once will report a failed deployment for a first install that is
in fact fine, so a first install should be run by hand, or the apply step given a retry.

For a first apply that costs less and finishes sooner, set the five tier flags in
[The cheap development profile](#the-cheap-development-profile) before this step. That profile still
creates the user pool, every table and bucket, the intake API and the whole agent tier — it skips the
NAT gateway, the ECS/ALB/CloudFront serving tier, the knowledge-base corpus, the evals and the
observability delivery — and the console then runs on your laptop against it.

### 4. Make it signable-in

The apply creates the identity provider; it cannot create the people. What is left depends on
`auth_provider`.

**`cognito` (the default).** The pool exists with its five console groups and **no users** — self
sign-up is disabled on purpose, so at this point nobody can open the console and the sign-in page
offers no way to make an account. Two ways to fix that, and `post_deploy_checklist` says so in the
apply output:

```bash
cd infra/environments/recon
terraform output cognito_first_user_commands   # the two CLI calls for ONE real operator; edit the address
terraform output cognito_hosted_ui_url         # the sign-in page, openable directly to check the pool

# or five fictional accounts that demonstrate the whole access model at once
python3 ../../../scripts/create_dev_users.py --dry-run
python3 ../../../scripts/create_dev_users.py          # prompts, twice, without echo
```

Access comes from **group membership, not from the account existing**: the pool's five groups are
created empty, so a new user with no group sees the no-access state until an operator adds them to
one. `scripts/create_dev_users.py` is described in [`scripts/README.md`](scripts/README.md); it is
idempotent, has a `--dry-run` and a `--delete`, and never writes a password to a file.

The five accounts are fixed, all at `example.com` (RFC 2606 reserves it, so none can receive mail and
`--delete` can never remove a real operator's account), and each one exists to show a state the others
cannot:

| Account                      | Groups                | What signing in as it demonstrates                                                                            |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `recon-analyst@example.com`  | recon access only     | Trade Reconciliation alone — the rail shows one app, and the Deal Pipeline is not merely disabled but absent     |
| `deal-desk-user@example.com` | pipeline access only  | Deal Pipeline alone, the mirror image, which is what proves the two apps' access is genuinely independent        |
| `both-apps-admin@example.com`| both **admin** groups | Both apps with every admin control: the Config tabs, approvals, the threshold, the backend switch               |
| `console-admin@example.com`  | console admin only    | The `/console/settings` screen and **neither app** — the state that proves the console-wide layer is separate from app access |
| `no-access@example.com`      | none                  | What an authenticated stranger gets. Under Cognito this is the **default** state of every new account, because the pool creates its groups empty |

One temporary password serves all five. The script prompts for it twice, without echo, and never
echoes it back, writes it to a file, or defaults it — the operator typed it, so the only copy is
already theirs. Every account lands in `FORCE_CHANGE_PASSWORD` and sets its own at first sign-in. No
invite mail is sent (`MessageAction="SUPPRESS"`) — it would carry that password to five undeliverable
addresses.

The console's own callback and sign-out URLs are registered on the app client by the apply itself
(`enable_cognito_callback_patch`), because Cognito matches a redirect URL exactly and the CloudFront
domain does not exist when the client is created. The `patch_cognito_callbacks` action in
`infra/modules/deploy-actions/src/handler.py` does it: it reads the live client, replaces only the two
URL lists, and writes everything else back as found. Set `enable_cognito_callback_patch = false` to
keep that actor out of Cognito and register the two URLs `post_deploy_checklist` prints by hand
instead.

**`okta`.** Register the `okta_redirect_uri_to_register` output as a sign-in redirect URI on the Okta
OIDC app, and `frontend_url` as a sign-out redirect URI. This needs an Okta org admin. Until the
callback URI is registered, login cannot complete and every route stops at `400 invalid_request`.

**`entra`.** The MSAL flow returns to the app's own origin, so there is no callback path to register;
the app registration supplies `entra_tenant_id` and `entra_client_id`, and the group claim has to be
released by the app manifest (`auth_groups_claim` names `groups` or `roles` accordingly).

For either external provider, the groups the console checks must exist in that tenant and nothing here
can create them — see [Two applications, one console](#two-applications-one-console).

### 5. Give recon something to reconcile

The apply creates the machinery, not the content — the same class of gap as step 4, and the one that
looks most like a broken deployment. **The Deal Pipeline seeds its own demo corpus at apply time**
(seven fictional new-issue emails from `data/deal-emails/`, uploaded to the pipeline bucket under
`samples/`), so it demonstrates itself the moment it is deployed. **Recon does not.** A `ReconItem` row
reaches the items table only from the intake API or from a structured feed, and a fresh account has
neither — so a first apply ends with an empty queue, an empty dashboard and no case to open. That state
is indistinguishable from a stack that is wired up wrong: there is nothing to click, and no way to tell
"working, with no data" from "the agent never ran".

```bash
AWS_PROFILE=<profile> python3 scripts/seed_recon_demo_items.py --dry-run   # prints the six rows, writes nothing
AWS_PROFILE=<profile> python3 scripts/seed_recon_demo_items.py             # seed all six
```

With no `--items-table` the script reads the `items_table` Terraform output from
`infra/environments/recon`, so it follows whatever `name_prefix` this deployment used. `--items-table
<name> --region <region>` covers a checkout with no state (the table is `<name_prefix>-items`), and
`--scenario <name>` seeds one at a time.

**Two things about credentials, because the flags do not cover both halves of the run.** With
`--items-table <name>`, `--dry-run` needs no credentials and no resolvable region, because it builds no
client at all (`scripts/seed_recon_demo_items.py:809-812`). Resolving the table from Terraform instead
does need them even under `--dry-run`: `main()` shells out to `terraform output -json` in
`infra/environments/recon` first (`:795-797`, `:551-557`), and that root's state is remote
(`backend "s3"` in `infra/environments/recon/backend.tf`), so reading the output is an S3 read. And
`--profile` reaches only the boto3 session (`:811`), never the `terraform` subprocess — so export
`AWS_PROFILE`, as above, rather than passing `--profile`, or the state read silently uses your default
credentials while the flag you supplied applies to the DynamoDB write alone.

**It writes items, not cases, and that is the whole design.** `<name_prefix>-items` is the platform's
only stream-enabled table, and an item write is what runs Tier-1: the Tier-1 Lambda consumes the
stream, applies the deterministic engine, and either auto-clears the item into a terminal case or opens
a `PENDING` one for the Tier-2 agent. Writing case rows directly would produce six records nothing had
reasoned about — no `tier1_match` evidence, no `tier1_escalation_reason`, no break-type hint, and
nothing to dispatch the agent. Seeding items means what you see afterwards is what the platform
decided, not what the script asserted. Every amount, borrower, facility and wire reference is read off
`data/general-ledger/gl-entries.csv`, the mocked ledger the `gl-query` Lambda serves through Athena, so
the two ledger-lookup items match rows that really exist and the agent's own ledger searches return
something. The names are this repo's fictional corpus; no real institution appears.

**What you should see, and where.** Give Tier-1 a few seconds — the stream trigger is `LATEST` with a
batch of 10, so all six arrive in one or two invocations and the deterministic tier decides without a
model. Two items auto-clear, on two **different** paths, and four escalate naming four **different**
reasons:

| Scenario              | Tier-1 does                      | Why, and what the case shows                                                                                                                       |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoclear-interest`  | `AUTO_CLEARED` / `amount-match`  | Two sides differing by 0.02, inside the 0.05 tolerance. `tier1_match` reads `matched_on: rule`, with both compared values and the margin             |
| `ledger-match`        | `AUTO_CLEARED` / `gl-match`      | **No sides at all**, so the only counterpart is the ledger; exactly one row is within tolerance. `tier1_match` reads `matched_on: general_ledger` and embeds the matched row. No model runs on either of these two |
| `amount-mismatch`     | `PENDING` / `tolerance_miss`     | Both sides are booked and disagree by 3,655.20 — a real break, for the agent to check against the ledger row for the same wire                       |
| `ledger-ambiguous`    | `PENDING` / `gl_ambiguous`       | No sides, and **two** ledger rows within tolerance under one wire settling two facilities. The deterministic lookup refuses to choose, attaches both as `gl_candidates`, and hands the aggregation judgement to the agent |
| `missing-amount`      | `PENDING` / `missing_match_attr` | The expected side omits `amount` entirely. A data-quality problem upstream, **not** a reconciliation difference, and the agent is told which it is looking at |
| `unparseable-amount`  | `PENDING` / `unparseable_amount` | The expected side carries `n/a` where a number belongs. Named separately from the row above on purpose: "no amount" and "not a number" are different problems |

Open `/recon/queue` — the default OPEN filter lists the four escalated cases as `PENDING`, each detail
screen naming its own escalation reason and a break-type of `record-match-review` (two sides) or
`ledger-status-resolution` (no sides). Switch the status filter to `AUTO_CLEARED` for the two Tier-1
resolved by itself. The escalated four then move without anyone pressing anything: Tier-1 nudges the
Tier-2 map run on every escalation and the run is scheduled on top of that, so each case goes
`PENDING → IN_PROGRESS → PROPOSED` within a couple of minutes. That wait is model latency. A case that
stays `PENDING` means the agent tier is not running; one that reaches `FAILED` means the investigation
errored, and the trace on the case says where.

Re-running is free — the ids are derived from a fixed prefix and ordinal with no clock and no uuid, and
the write is the same conditional put intake uses, so a second run reports six `SKIP` and never
re-fires Tier-1 for an item already in flight. `--delete` removes the six **items** by exact key and
refuses any id outside its own prefix, so it never scans and can never remove a row an analyst or the
intake API wrote; the cases stay, which means "delete then re-seed" does not reset the demo. The delete
run prints the `aws dynamodb delete-item` calls for the case rows if you want to replay from scratch.
Full detail is in [`scripts/README.md`](scripts/README.md#seed_recon_demo_itemspy--giving-a-fresh-deployment-something-to-reconcile).

### 6. Point recon at the IDP document-processing state machine (if applicable)

Set `idp_state_machine_arn` to the ARN of the IDP deployment's document-processing Step Functions
state machine, from that stack's outputs. An ARN and not a name, because IDP's stack generates a
suffix that changes on every rebuild. Recon owns the EventBridge rule that matches that state
machine's execution-status changes, and that rule is the only thing that invokes the ingest hook.

Leave it empty and the rule is not created at all (`count = var.idp_state_machine_arn == "" ? 0 : 1`),
so nothing reaches the hook: uploads complete, the pipeline runs, and the notices table stays
permanently empty with no error anywhere. `terraform apply` names the gap in its
`post_deploy_checklist` output rather than leaving it to be discovered.

The rule matches `SUCCEEDED` plus every terminal non-`SUCCEEDED` status — `FAILED`, `TIMED_OUT`,
`ABORTED` — because the hook records a tracking-only row for the outcomes that produced no notice, so
a document cannot silently vanish from the Documents tab. It matches a state machine and not a
configuration version, so recon ingests a row for every document that pipeline finishes, including
another deployment's; the Documents tab is what filters by pinned configuration version.

The IDP solution's own `PostProcessingLambdaHookFunctionArn` parameter is an alternative registration
path for the same completion event, and this repo deliberately leaves it unset — it is a setting
inside a stack this repo does not deploy and cannot verify from here. A Lambda permission is a grant,
not an invocation: with that parameter empty and no rule on this side, the hook never fires and
nothing reports it. If you do register the hook there instead — pointing it at the
`idp_hook_function_arn` output — leave `idp_state_machine_arn` empty. Exactly one of the two may be
wired, since both deliver the same event and both together ingest every document twice.

### 7. Optional flips

```bash
# Harness instead of the runtime backend (instant A/B; flip back with agent_backend=runtime)
terraform apply -var="agent_backend=harness"

# Policy is ENFORCE by default; LOG_ONLY observes decisions without blocking
terraform apply -var="policy_enforcement_mode=LOG_ONLY"
```

### 8. Run the tests

```bash
# Backend (repo root). The suite imports the same backend modules the agent container runs,
# so it needs the runtime requirements as well as the test-only ones.
pip install -r agent-blueprint/recon-agent/requirements.txt -r requirements-dev.txt
export AWS_DEFAULT_REGION=us-east-1   # moto builds real boto3 clients; botocore needs a region
ruff check .
python -m pytest -q            # 2179 passed, 20 skipped, ~65s
#                              # 10 of the skips are in tests/integration/ — 9 need
#                              # RECON_GATEWAY_URL (+ dev-account creds), 1 also needs
#                              # EMAIL_CONFIRMATION_TOKEN. 4 are in tests/skills/, one per
#                              # skill that prescribes no required evidence steps. 6 are in
#                              # tests/input_corpus/test_extraction_config.py, one per document
#                              # class that does not configure both amount columns.

# Frontend (chatbot-app/frontend). `npm run build` is the gate that matters — it compiles
# every route, catching breakage both vitest and tsc miss.
cd chatbot-app/frontend && npm ci && npx tsc --noEmit && npx vitest run && npm run build
#                          # 143 files, 2051 passed
#                          # `npm run build` rewrites next-env.d.ts; `git checkout -- next-env.d.ts`

# Terraform module tests (plan-only, mocked providers, no credentials). Both CIs run these.
for tests in infra/modules/*/tests; do
  (cd "$(dirname "$tests")" && terraform init -backend=false && terraform test)
done
#                          # 74 tests across 8 modules
```

`npm run lint` is not part of this: ESLint is broken repo-wide. `npm run verify` points at a
`verify-build.sh` that does not exist. `ruff format --check` reports 33 files that predate the
convention, so formatting is not gated either. CI runs exactly the commands above.

These counts are a snapshot, not a gate — nothing asserts them, so treat a disagreement as this
line being stale rather than as a missing test, and re-measure before quoting it.

## The cheap development profile

Five tier flags, all `true` by default, so an existing `terraform.tfvars` deploys exactly what it
deployed before they existed. Turning them off applies the parts needed to exercise both console apps
against **real AWS** from a laptop, without the parts that cost money every hour or add half an hour to
a first apply:

```hcl
enable_frontend_tier         = false  # no image build, ECS service, ALB, CloudFront or WAF
enable_private_networking    = false  # no NAT gateway; Lambdas + the runtime run unattached to the VPC
enable_knowledge_base_corpus = false  # no corpus upload and no ingestion poll; the KB stays empty
enable_agent_evals           = false  # no judge-model spend per session
enable_observability         = false  # no runtime spans or OTEL logs delivered to CloudWatch
```

**What that still creates**, because a developer needs it: the Cognito user pool with its hosted UI,
app client and five groups; every DynamoDB table and S3 bucket; the SSM parameter layers; the shared
Lambda zip and every Lambda that runs from it; the intake HTTP API; the Deal Pipeline's own resources
when `enable_deal_pipeline` is set; **and the recon agent tier** — the AgentCore Runtime container
(a CodeBuild image build, so even this apply is not a fast one), the managed harness, the tools gateway
with its targets, and Tier-1/Tier-2. The agent is what turns an intaken item into a case, so a console
with no agent has an empty queue; it is deliberately not behind a flag.

Then run the console on the laptop, create the users to sign in as, and seed a queue to look at:

```bash
cd infra/environments/recon
terraform output -raw frontend_env_local > ../../../chatbot-app/frontend/.env.local
python3 ../../../scripts/create_dev_users.py --dry-run       # then without --dry-run
python3 ../../../scripts/seed_recon_demo_items.py --dry-run  # then without --dry-run  (step 5)
cd ../../../chatbot-app/frontend && npm run dev              # the BFF runs as YOUR AWS credentials
```

`frontend_env_local` renders a complete `.env.local` — from the console task's own environment when the
frontend tier is deployed, and from this root's own values when it is not, with a `check` block
comparing the two whenever both exist so a laptop and the container cannot silently disagree. It is a
`sensitive` output (the environment carries `EMAIL_CONFIRMATION_TOKEN`), so `output -raw` is how you
read it, and `.env.local` is gitignored. Re-render it after an apply rather than editing it by hand.

**What this profile does not exercise.** Worth stating, because each gap is invisible from the laptop:

- **The whole serving path.** No image build, so nothing catches a container-only build failure; no
  ALB, no CloudFront and no WAF, so the CSP and security headers (which live in
  `infra/modules/frontend-ecs`, not in `next.config.js`) are not applied, and the document-preview
  behaviour that depends on `frame-src blob:` cannot be reproduced. No task role either: the BFF runs
  with your own credentials, which are almost certainly wider than the task's, so a missing task-role
  grant does not surface.
- **The hosted-UI redirect against a real domain.** With no distribution there is no public host to
  register, so the Cognito callback patch is skipped and only the `localhost` URLs the app client was
  created with are registered. A redirect problem that only appears on the deployed domain — a
  mismatched callback, a sign-out URL with a trailing slash — cannot be seen here.
- **Sign-in at all, by default.** The rendered file sets `ALLOW_ANONYMOUS_API=true`, which replaces
  token verification with one anonymous subject holding every configured group; and the browser gate
  passes through unauthenticated on `localhost` / `127.0.0.1` anyway (parity with the Okta and Entra
  wrappers), so no provider redirect happens. To exercise the real Cognito flow from a laptop, remove
  `ALLOW_ANONYMOUS_API` and uncomment the server-side `AUTH_PROVIDER` / `COGNITO_USER_POOL_ID` /
  `COGNITO_CLIENT_ID` lines the output leaves commented for exactly this purpose. The gate still does
  not redirect on localhost — the **first BFF 401** does, through `src/lib/reauth.ts`, and it completes
  because `cognito_local_dev_callbacks` registered `http://localhost:3000/callback`. Use
  `ANONYMOUS_GROUPS` instead when all you want is to preview what a restricted user sees.
- **Anything a flag switched off.** An empty knowledge base, an unscored Evals tab and a traceless
  investigation all look like working screens with nothing in them. `post_deploy_checklist` prints one
  line per flag that is off for that reason.

## CI/CD

Two pipeline samples — `.github/workflows/ci.yml` (verification only, no AWS credentials in any job)
and `.gitlab-ci.yml` (the same verification plus SAST, then `plan` + `apply` on `main`). The four
verification jobs, the GitLab-only SAST gate, and the three CI/CD variables the pipeline needs are in
**[assets/ci-cd.md](assets/ci-cd.md)**.

## Prerequisites & configuration

| Variable                                   | Required | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region`                                   | yes      | AWS region (default `us-east-1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `name_prefix`                              | yes      | Resource name prefix. Must be **globally unique**, not merely unique in your account: `infra/modules/foundation` derives two S3 bucket names from it with no account suffix (`${name_prefix}-raw`, `${name_prefix}-assets`), so pick something with entropy — `recon-<team>-<4 hex>`. The shipped default `recon-dev` is already taken; see [step 2](#2-create-the-two-local-config-files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `otel_layer_account`                       | **yes**  | AWS's own public publisher account for the `AWSOpenTelemetryDistroPython` layer. It declares no default on purpose: a wrong or absent value composes a valid-looking layer ARN that fails at apply with an opaque Lambda error, so Terraform stops and names the variable instead. Not a secret. It lives in tfvars only because the repo's pre-push guard rejects any 12-digit run in a committed file. Only read when `enable_worker_tracing = true`, though `terraform plan` requires it either way                                                        |
| `idp_state_machine_arn`                    | no       | ARN of the IDP document-processing Step Functions state machine. Recon's own EventBridge rule matches its terminal execution statuses, and that rule is the only thing that invokes the ingest hook — so an environment with an IDP deployment **must** set it. Empty creates no rule: uploads complete and the notices table stays empty with no error anywhere. Mutually exclusive with registering the hook on the IDP side (step 6)                                                                                                                       |
| `idp_input_bucket`                         | no       | Name of the IDP deployment's input bucket, from that stack's outputs. The Documents tab streams a document's source bytes from it, and an extraction-routed upload is put into it. Empty leaves the preview reporting it has nowhere to read from and the upload route nowhere to put a file — which is the correct behaviour, since the alternative is a put that lands where nothing reads it                                                                                                                                                               |
| `idp_input_bucket_arn`                     | no       | ARN of the same bucket. Only the console task role is granted on it, and only `s3:PutObject` on the object path — never `ListBucket`, and never on the pipeline's output prefixes                                                                                                                                                                                                                                                                                                                                                                             |
| `graph_enabled`                            | no       | Enable the `microsoft-graph` OpenAPI target (the platform's single email interface)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `graph_mailbox`                            | no       | Shared mailbox SMTP address all Graph email is sent from / read (must be a real mailbox in the Entra tenant)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `notify_email`                             | no       | Resolution-notification recipient (human approve + auto-resolve), sent **from** `graph_mailbox` via the gateway's `sendSharedMailboxMail` tool. Empty disables the email step. The dev environment points it at the shared mailbox itself, so notifications land in the same inbox the agent reads                                                                                                                                                                                                                                                            |
| `entra_tenant_id/client_id/client_secret`  | no       | Entra app-only credentials for Graph email. `entra_tenant_id` + `entra_client_id` are **also** the intake API's JWT authorizer when `auth_provider=entra`, and the plan fails without them then                                                                                                                                                                                                                                                                                                                                                      |
| `auth_provider`                            | no       | Identity provider for BOTH the console login and the intake API's JWT authorizer: **`cognito` (the default)**, `okta` or `entra`. `cognito` instantiates `infra/modules/console-auth` and needs no external tenant; the same pool issues the tokens the intake API validates, so the deployment has exactly one identity provider. `okta` and `entra` create no pool and must be fully configured or the plan fails. A value that is none of the three is refused at plan                                                                                                                                                                                                                                                                                                                                        |
| `cognito_hosted_ui_prefix`                 | **yes**, with `cognito` | The sign-in host, `<prefix>.auth.<region>.amazoncognito.com`. Globally unique across every AWS account, so it declares no default — add entropy — and it may not contain `aws`, `amazon` or `cognito`, which Cognito reserves. Cross-variable validation requires it only for this provider, so an Okta or Entra deployment never names a login domain it does not have |
| `cognito_mfa_configuration`                | no       | `OPTIONAL` (default — TOTP offered and skippable), `ON` (TOTP required for everyone, enrolled before the console is reachable) or `OFF`. SMS is offered in no mode. `post_deploy_checklist` warns on every apply that is not `ON` |
| `cognito_deletion_protection`              | no       | `INACTIVE` (default) so `terraform destroy` can remove the pool, which is what a sample being trialled needs. `ACTIVE` for a pool whose user list matters: recreating it changes the token issuer and every `sub`, so the audit trail's author ids stop resolving |
| `cognito_local_dev_callbacks` / `cognito_local_dev_port` | no | `true` / `3000` (defaults) also register `http://localhost:<port>/callback` and `http://localhost:<port>` on the app client, so `npm run dev` can sign in against this deployment's pool. Cognito permits plain http for localhost only. `false` allows sign-in from the console's deployed host alone |
| `cognito_redirect_uri`                     | no       | Pins the OAuth callback instead of letting the browser derive it from its own origin. Must end in `/callback` — that is the Cognito route; `/login/callback` is Okta's. Only needed when the console answers on more than one host |
| `cognito_extra_callback_urls` / `cognito_extra_logout_urls` | no | Further URLs to register on the app client — a custom domain, a second environment. Cognito compares exactly, so a callback entry is a full URL including its path and a sign-out entry is a bare origin with no trailing slash |
| `cognito_supported_identity_providers`     | no       | `["COGNITO"]` (default) is the pool's own directory. To federate an enterprise IdP, add an `aws_cognito_identity_provider` to the pool and **add its name here too** — the provider resource alone does not make the sign-in page offer it, and dropping `"COGNITO"` disables local pool users entirely. See [Authentication](#authentication) |
| `enable_cognito_callback_patch`            | no       | `true` (default) registers this deployment's own callback and sign-out URLs on the app client at the end of the apply, because Cognito matches a redirect URL exactly and the CloudFront domain does not exist when the client is created. The `patch_cognito_callbacks` action reads the live client and replaces only those two lists. `false` keeps the deploy-time actor out of Cognito; register the two URLs `post_deploy_checklist` prints by hand instead |
| `okta_issuer` / `okta_client_id`           | no       | Required when `auth_provider=okta`. They configure the console login **and** the intake API's authorizer — derived once in the root module's `oidc_*` locals so the API and the BFF accept identical tokens                                                                                                                                                                                                                                                                                                                                                   |
| `agent_backend`                            | no       | `runtime` (default) or `harness`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `enable_deal_pipeline`                                                                        | no       | `false` (default) deploys the recon app alone. `true` composes `infra/modules/deal-pipeline` into this environment under the `<name_prefix>-pipeline` prefix and hands the console's task the `PIPELINE_*` variables plus `REQUIRE_ACCESS_GROUPS=true` and `PIPELINE_ENABLED=true`, so the Deal Pipeline app appears in the rail. The plan is **refused** while `recon_access_group` or `pipeline_access_group` is blank — see [Two applications, one console](#two-applications-one-console)                                                                                                                                                                                                                                              |
| `recon_admin_group` / `recon_access_group` / `pipeline_admin_group` / `pipeline_access_group` | no       | The identity-provider groups behind `RECON_ADMIN_GROUP`, `RECON_ACCESS_GROUP`, `PIPELINE_ADMIN_GROUP`, `PIPELINE_ACCESS_GROUP`. With the pipeline off, an empty access group leaves recon open to every authenticated user; an empty admin group means nobody can change that app. With `enable_deal_pipeline = true` both access groups are required (the plan fails otherwise) and the task runs with `REQUIRE_ACCESS_GROUPS=true`, so a blank one would deny rather than open                                                                                                                                                                                                                                                           |
| `console_admin_group` / `console_organization_label`                                          | no       | The console-wide layer — see [Console-wide configuration](#console-wide-configuration). `console_admin_group` is the identity-provider group behind `CONSOLE_ADMIN_GROUP` (who may edit console-wide settings; empty = nobody, fail closed, and it can never be changed from the UI). `console_organization_label` (default `Agentic Operations Console`) reaches the task as `CONSOLE_ORGANIZATION_LABEL` and seeds `<prefix>/defaults/organization-label`. The same apply seeds the four groups, the pipeline switch and the default model id (from `pipeline_agent_model_id`) under `/<name_prefix>/console` through `infra/modules/console-settings`; a value later changed from the Settings screen is **never reverted** by an apply |
| `harness_model_id`                         | no       | Override harness LLM (default `us.anthropic.claude-sonnet-5`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `policy_enforcement_mode`                  | no       | `ENFORCE` (default) or `LOG_ONLY` (observe only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `interceptor_mode`                         | no       | Gateway REQUEST interceptor: `enforce` (default) or `log` (observes only, **never blocks**). The example tfvars also ships `"enforce"` explicitly; set `"log"` only for a first rollout, then remove it.                                                                                                                                                                                                                                                                                                                                                      |
| `enable_worker_tracing`                    | no       | `true` (default) attaches the ADOT layer and OTel env to the agent-worker AND the Tier-2 dispatch Lambdas so its invocations share one trace with the agent's own spans. `false` means no layer, no OTel env, PassThrough X-Ray. On the runtime backend the dispatcher is the InvokeAgentRuntime caller, so without it that trace has no client end                                                                                                                                                                                                           |
| `max_concurrent_investigations`            | no       | `14` (default). Ceiling on simultaneous Tier-2 investigations — the Bedrock token budget, applied as the Distributed Map's `MaxConcurrency` for the runtime backend and as reserved concurrency on the worker for the harness backend. Bounded on BOTH sides: too high throttles the model, too low lets the tail of a burst outlive the async queue's retention. Not a tuning knob                                                                                                                                                                           |
| `schedule_enabled` / `schedule_expression` | —        | **Not root variables.** They are `infra/modules/tier2-dispatch` inputs, and the root passes `true` and `rate(1 minute)` as literals (`main.tf`, the `tier2_dispatch` module block). The schedule is a safety net rather than the primary trigger — Tier-1 nudges the map run the moment it escalates — so changing the cadence is a one-line edit in the root, not a tfvars value                                                                                                                                                                                                                                                                                                                                           |
| `otel_layer_version`                       | no       | Version of AWS's public `AWSOpenTelemetryDistroPython` Lambda layer (default `30`; pinned rather than `latest`, which AWS does not publish)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reprocess_cap`                            | no       | Max re-process attempts before a case ages out (default `3`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `private_vpc`                              | no       | `false` (default) = public CloudFront + internet-facing ALB. `true` = the whole private topology in one flag: internal ALB on private subnets, Fargate with no public IP, no CloudFront, the interface endpoints, plus a VPC-only PRIVATE REST API onto the intake Lambda (an HTTP API cannot be made private, so `POST /items` would otherwise stay internet-facing). Does **not** remove the NAT — see [Private VPC deployment](assets/private-vpc-deployment.md) and [the intake API](assets/intake-http-api.md#reaching-it-from-a-private-vpc-deployment) |
| `private_ingress_cidrs`                    | no       | CIDRs allowed to reach the internal ALB when `private_vpc=true` (VPN/corporate ranges). Empty ⇒ the VPC CIDR only. Ignored when `private_vpc=false`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `enable_frontend_tier`                     | no       | `true` (default) builds and runs the console's serving tier: the container image build, ECR repository, ECS cluster and Fargate service, the ALB, CloudFront and its WAF web ACL. `false` skips all of it, and the console runs on a laptop from `frontend_env_local` instead — see [The cheap development profile](#the-cheap-development-profile) |
| `enable_private_networking`                | no       | `true` (default) creates the private networking tier: two private subnets, the NAT gateway and its EIP, the S3/DynamoDB gateway endpoints and (with `private_vpc`) the interface endpoints. `false` removes the standing NAT charge and every VPC-attached Lambda plus the AgentCore Runtime then runs **unattached** (`vpc_subnet_ids = []`): they still reach AWS, over the Lambda service network, but nothing that is only reachable inside the VPC is reachable from them. `private_vpc = true` requires this to be `true` |
| `enable_knowledge_base_corpus`             | no       | `true` (default) uploads the sample guidance corpus and ingests it, and creates the upload-ingestion trigger. `false` leaves the knowledge base **empty**, so `consult-guidance` retrieves nothing with no error anywhere. It does not remove the knowledge base itself, which lives in `modules/recon-agent` |
| `enable_agent_evals`                       | no       | `true` (default) creates the analyst-agreement evaluator Lambda and the two online evaluation configs. `false` removes a recurring **model** spend rather than an hourly resource charge; the Evals tab then has no results and the batch route no evaluator, and `online_evals_enabled` is ignored |
| `enable_observability`                     | no       | `true` (default) delivers the AgentCore Runtime's OTEL logs to CloudWatch and its traces to X-Ray. `false` skips both: a failed investigation has no trace, and RUNTIME-backend sessions cannot be scored even with `enable_agent_evals = true`, because the eval service reads content only from delivered log groups |

Copy `infra/environments/recon/terraform.tfvars.example` → `terraform.tfvars` and fill values.
`terraform.tfvars.example` is the only committed record of which variables an environment is
expected to set — add a placeholder entry there (never a real credential) in the same change that
adds a variable.

---

## Case lifecycle

![Case lifecycle](assets/case-lifecycle.svg)

An item is ingested as `PENDING`, deterministically cleared to `AUTO_CLEARED` or escalated — an
escalated case STAYS `PENDING` until a Tier-2 map run claims it to `IN_PROGRESS`, because the stream
consumer no longer dispatches — and then either `PROPOSED` for an analyst or executed autonomously straight to
`APPROVED` → `RESOLVED`. `AUTO_CLEARED`, `RESOLVED`, `CLOSED_NO_ACTION` and `AGED` are terminal;
`FAILED` deliberately is not, so it acts as a retry queue. The full state machine, the step-by-step
account of who performs each transition, and the terminal-state rules are in
**[assets/case-lifecycle.md](assets/case-lifecycle.md)**.

---

## The Reconciliation Agent & pre-created skills

The Tier-2 agent runs on one of two interchangeable backends (below). Skills are a composable
library of investigation and resolution _procedures_, not classification categories: the agent gets
handed the whole library and invokes as many of them as the item warrants. Each escalated item goes
through one loop:

1. **Recall lessons.** Retrieve the most relevant consolidated analyst lessons for the item's
   domain from AgentCore Memory (`lessons_learned` strategy). Advisory, fail-soft.
2. **Characterize the break.** The model assesses what kind of exception the item is (name and
   reasoning — it is not asked how sure it is). This seeds the case class, which selects the skill
   whose prescribed evidence steps the confidence is then scored against; it does not restrict which
   skills may run. A name that is not in the catalog is recorded as `unknown`, which declares no
   evidence steps and therefore always escalates.
3. **Investigate.** The agent receives the full skill library, where each skill's markdown body
   _is_ its procedure, and runs whichever ones apply, composing several when the evidence warrants.
   Their tool calls (by the runtime's short aliases: `search_ledger`, `search_notices`,
   `search_guidance`, `search_correspondence`, `list_contacts`, `list_templates` — all
   reads) each land in the trace as a typed `ReasoningStep` carrying reasoning, cited evidence, and
   tool I/O. Each alias resolves to a fully-qualified gateway tool (`search_guidance` →
   `managed-kb___Retrieve`); a skill's `tools:` frontmatter names the qualified form, not the alias.
4. **Propose.** A final pass produces the resolution, a per-evidence-step outcome report, and a structured
   `proposed_action`. The ledger reference in it is derived by the worker from the `search_ledger`
   results rather than supplied by the model; zero matches or more than one distinct match means no
   action, which forces an escalation.
5. **Execute or escalate.** If the evidence-completeness score clears the threshold and a clean action exists, the
   platform (the worker or runtime process, never the model) performs the Policy-gated
   `set_draw_status` write on the agent's behalf and the case auto-resolves. Otherwise it halts at
   `PROPOSED` for human review.

### Two backends (`agent_backend` — instant A/B + rollback)

| Backend                 | Where                                                             | How it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`runtime`** (default) | `agent-blueprint/recon-agent/`                                    | An arm64 AgentCore Runtime container running a Strands `Agent` agentic loop (`strands_investigator.py`) with k-sample self-consistency classification. That classification is also a Strands call: every Bedrock request this container makes goes through the SDK with `streaming=False`. It makes autonomous gateway tool calls over MCP (SigV4) and returns a JSON proposal. Tools granted (short aliases; each maps to a `<target>___<tool>` gateway name in `gateway_mcp.py`): `search_ledger`, `search_notices`, `search_guidance`, `search_correspondence`, `list_contacts`, `list_templates` — reads only, no send. This is the granted surface, which is wider than what the shipped skills name. |
| **`harness`**           | `agent-blueprint/recon-agent-harness/` + `backend/harness_agent/` | The managed AgentCore Harness, declared in config with no orchestration container of ours. The harness calls the egress gateway (the `agentCoreGateway` tool) plus an `inline_function submit_proposal`, and a thin worker drives the round-trip, assembles the trace from the event stream, derives the reference, computes the evidence-completeness confidence and persists.                                                                                                                                                                                                                                                                                                                            |

Both backends share the egress gateway, Memory, KB, DynamoDB, and the same SKILL.md skill set, and
both reach the same Microsoft Graph surface — for reading only. Mailbox reads go through the
sanitized `search_correspondence(query, top)` wrapper, because the raw Graph op's `$`-prefixed OData
arguments are not legal tool-schema property names. Neither backend holds a send tool: a
counterparty email is data the model writes into its proposal, and the BFF sends the revision an
analyst approved. Both models are propose-only. Neither is given
`set_draw_status`, and the confidence-gated write happens after the proposal in
`auto_resolve.autonomous_execute`, where the harness worker and the runtime container run the same
code. What differs between the two is the calling mechanics, meaning who drives the loop and where
the trace comes from, not the tool surface.

On the map-run path the runtime is reached by the Tier-2 **dispatcher** Lambda calling
`InvokeAgentRuntime` **directly**. The ingress gateway is deliberately not used there: it holds the
connection until the runtime session ends, so it cannot forward the container's immediate
`{"status": "accepted"}` — routing async dispatch through it reinstates the blocking behaviour the
design removes. The gateway remains the audited SigV4 entry point for the agent-worker's
**synchronous** paths (the harness backend and the console's single-case retry), which read the
response and so lose nothing by waiting.

Skills live as `SKILL.md` files in S3, one directory per skill (`skills/<name>/SKILL.md`), with
frontmatter (`name`, `description`, `tools: [<gateway tools>]`, optional `model`) and a free-text
procedure body. The catalog is a composable library rather than a one-of-N classification registry:
the agent is handed every skill and invokes the relevant ones, and `unknown` is the
escalate-with-context fallback for when nothing conclusive applies. Create or edit a skill in the
Skills tab and the agent picks it up within about 60 s, no redeploy. The system prompt is just as
live-editable. Nothing gates the break-characterization step: a name outside the catalog becomes
`unknown`, and escalation is decided later by the computed score.

### Pre-created skills

These ship as a starting library. They are composable rather than mutually exclusive, and one
reconciliation often uses several: `document-cross-reference` plus `record-match-review` plus
`correspondence-search`, then `ledger-status-resolution` to act on what they turned up.

| Skill                        | Tier         | Tools (`tools:` frontmatter, verbatim)                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record-match-review`        | `break-type` | `general-ledger___search_ledger`<br>`notices___search_notices` | Compare the two sides' key attributes (amount, date, identifier) with tolerance and aggregation to confirm or refute a match                                                                                                                                                                                                                                                                                                                                                                 |
| `document-cross-reference`   | `probe`      | `general-ledger___search_ledger`<br>`notices___search_notices` | Compare a source document's extracted fields — read off its own notice row as `idp_sections`, which `search_notices` returns, so there is no call into the extraction pipeline — against ledger records to confirm or refute a candidate match                                                                                                                                                                                                                                               |
| `consult-guidance`           | `probe`      | `managed-kb___Retrieve`                                        | Retrieve guidance, playbooks and archived counterparty correspondence from the recon Knowledge Base, narrowed by a metadata filter (`doc_type`, `break_class`, `skill`, `message_id`, date bounds). The runtime wraps this tool under the local Strands alias `search_guidance`, which builds the nested `Retrieve` argument shape                                                                                                                                                           |
| `correspondence-search`      | `probe`      | `correspondence-search___search_correspondence`                | Search the shared mailbox for messages that clarify the item — via the sanitized `correspondence-search` target, which builds the Graph OData arguments for the model                                                                                                                                                                                                                                                                                                                        |
| `counterparty-contact-draft` | `resolution` | `contacts___list_contacts`<br>`templates___list_templates`     | Cite a counterparty email into `submit_proposal`'s `email_draft` and stop. The model does **not** write the message: `email_draft` takes a `recipient_contact_id` (from `contacts___list_contacts`), a `template_id` (from `templates___list_templates`) and the template's `variables` — never a subject, a body or an address. The platform renders the wording, the analyst approves a revision on the case, and the BFF sends that exact text. No send tool is offered on either backend |
| `ledger-status-resolution`   | `break-type` | `set-draw-status___set_draw_status`                            | Resolve a confirmed break via a ledger status update (`{Confirmed, Cancelled, OnHold, Amended}`); executed by the worker/human-approve path as the Policy-gated write — reference derived from `search_ledger`, never model-supplied                                                                                                                                                                                                                                                         |
| `unknown`                    | `fallback`   | `[]`                                                           | Escalate-with-context fallback when no skill conclusively applies — gather context and escalate (not deletable)                                                                                                                                                                                                                                                                                                                                                                              |

`Tier` is the skill's declared `metadata.tier`, and it is descriptive only — **nothing routes on it.**
A `break-type` skill names the break's primary class, a `probe` is one the agent elects when the
investigation needs it, a `resolution` acts on what was found, and `fallback` is where an item lands
when nothing matched. Tier-1's class is an advisory hint the agent may overrule, not a dispatch key.

Tool names are given exactly as the frontmatter carries them — fully qualified as
`<target>___<tool>`, which is what a skill author has to type and what the runtime's `ALLOWED_TOOLS`
filter matches. Short names like `search_ledger` are the runtime's local Strands wrapper aliases, not
values the `tools:` key accepts.

The model is configurable per backend: runtime `MODEL_ID` (default `us.anthropic.claude-sonnet-5`),
harness `harness_model_id` (default `us.anthropic.claude-sonnet-5`).

### Confidence & auto-resolution (straight-through processing)

The **Overall Confidence** shown on the case, which is also what gets compared against the admin
threshold, is a computed **evidence-completeness** score (`confidence.py`):

    confidence = satisfied_required_steps / prescribed_required_steps

Every SKILL.md declares, in its front matter, the evidence steps an investigation under that skill
must obtain. The classified break type selects the skill; the agent reports per step whether that
step's tool call returned data answering it; the score is the fraction of the REQUIRED steps that
did. A four-step skill that obtained three scores 0.75.

Both backends call the same `score_proposal()` with the same trace, so the same document scores the
same whichever backend reconciled it — an identity rather than a reconciliation, unit-tested at each
backend's own entry point in `tests/recon_core/test_confidence_idp.py`.

**Coverage is not accuracy.** A proposal can satisfy every prescribed step and still match the wrong
record, scoring 1.0. Whether answers are _right_ is measured only by the labelled eval set and the
Online Evaluation configuration, never by this score.

Because the score is a rational fraction, a four-step skill can only produce 0.00, 0.25, 0.50, 0.75
or 1.00. At the 0.85 default threshold, no skill with fewer than seven required steps can
auto-resolve on anything short of full evidence (6/7 ≈ 0.857 is the first sub-perfect value that
clears). That is the intended posture.

The default threshold is set to 0.85, which in practice demands complete evidence for every skill
declaring six or fewer required steps, and sits deliberately at the conservative end of the
reachable band. Treat 0.85 as a stated assumption rather than a derived answer. No target
auto-execute rate was ever specified, and n=10 is far too small to fit a calibration curve to.
Operators should re-tune it against their own observed distribution; it is a live knob in the Config
tab, needs no redeploy, and rewrites the Cedar gate immediately.

The auto-resolve threshold (Config tab, default 0.85, disableable) is enforced by the AgentCore
Policy Cedar gate on the gateway in ENFORCE mode, and that gate is the single source of truth for
whether an autonomous write is permitted. Editing the threshold in the Config tab rewrites the Cedar
policy at runtime (`reconPolicy.ts` calling the Policy `UpdatePolicy` API), so the gate tracks the
admin value without a redeploy. The SSM value the worker reads is only an app-level hint, used to
decide execute-vs-escalate before it attempts the write at all.

---

## AgentCore Gateways, Policy & preconfigured tools

Two gateways, both AWS_IAM inbound (SigV4):

- **Egress tools gateway** (`recon-dev-gateway`) fronts all tool traffic: the agent's, the worker's,
  and the frontend BFF's platform calls. Two gateway-native enforcement layers sit on it.
  - **AgentCore Policy** (Cedar, `ENFORCE` by default). `recon_write_gate` permits
    `set_draw_status` when `context.input.confidence ≥ threshold`, which covers the agents and the
    worker. `recon_write_human` permits it for the BFF principal, since human approval carries no
    confidence value to test. `recon_status_platform` and `recon_status_forbid_agents` together make
    `recon_update_status` platform-only, so the model can never move its own case. Reads are
    unconditional. The Config-tab threshold edit rewrites `recon_write_gate` through the Policy API.
  - **REQUEST interceptor** (Lambda, `backend/gateway_interceptor/`) holds the three guards Cedar
    cannot express: provenance for the ledger write, where the reference must equal the persisted
    `proposed_action.reference`; a case state-machine re-check for `recon_update_status`; and the
    email gate on `sendSharedMailboxMail`. Every send needs a `confirmationToken` matching
    `EMAIL_CONFIRMATION_TOKEN` (stripped before the request reaches Graph) plus a `sendPurpose`
    saying which kind of send it is. A `notification` send may only address one of the addresses on
    the active `internal_notification` contacts, re-read from the contacts table on every send; an
    empty list refuses, in the same fail-closed direction as an empty counterparty domain allowlist.
    A `counterparty` send must name a `reconItemId` whose persisted draft is `approved`, at the
    revision that was approved, and must match that draft's subject and body byte for byte and the
    address its `recipient_contact_id` resolves to now — so the guard is provenance ("is this the
    text a human approved, going where they said?"), not just capability ("does the caller hold the
    token?"). Because the address is resolved rather than stored, an operator deactivating a contact
    revokes an already-approved send. A missing or unrecognized `sendPurpose` is denied. A new
    environment can be rolled out on `interceptor_mode = "log"` first, then flipped to `"enforce"`.

- **Ingress agent gateway** (`recon-dev-ingress-gateway`) is an `http/agentcoreRuntime` target
  fronting the Runtime: one controlled SigV4 entry point for the agent-worker's synchronous retry path and the BFF. The Tier-2 dispatcher deliberately does NOT use it — see the Tier-2 section.

### Egress tools

| Target                  | Type                                          | Enabled by                                   | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general-ledger`        | Lambda (Athena over S3)                       | `gl_tool_enabled` (root sets `true`)         | `search_ledger(reference, borrower, facility, amount, date)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `set-draw-status`       | Lambda (DynamoDB GL status overlay)           | `set_draw_status_enabled` (root sets `true`) | `set_draw_status(reference, status, reason, item_id, confidence)` — Policy-gated, provenance-checked write, executed by the worker (autonomous) or the BFF (human approve), never by the model.                                                                                                                                                                                                                                                                                                                                                                      |
| `recon-status`          | Lambda (cases + audit tables)                 | always                                       | `recon_update_status(item_id, new_status, comment, actor)` — **platform-only** (Cedar forbids agent principals); state-machine-guarded and audited.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `managed-kb`            | **Connector** (`bedrock-knowledge-bases`)     | always                                       | `Retrieve` — the Bedrock Retrieve API surfaced directly, no Lambda in the path, with NESTED arguments mirroring the Retrieve request. The agent supplies `retrievalQuery.text`, `numberOfResults` and a metadata `filter`; `knowledgeBaseId` is deliberately not an exposed override, and that omission is the trust boundary. Provisioned via `infra/modules/recon-agent/kb-connector-target.tf`.                                                                                                                                                                   |
| `microsoft-graph`       | OpenAPI target (app-only, client_credentials) | `graph_enabled` + Entra app credentials      | The one Graph interface for email. `sendSharedMailboxMail` sends from the shared mailbox and is platform-only; `listSharedMailboxMessages` reads it and is reached only through `correspondence-search`. See [The Graph target in detail](#the-graph-target-in-detail).                                                                                                                                                                                                                                                                                              |
| `correspondence-search` | Lambda (re-enters this gateway)               | always (shares `graph_mailbox`)              | `search_correspondence(query, top)` — the model-safe mailbox read. Registered unconditionally, so with `graph_enabled = false` the target exists and its inner call has no Graph target to reach. Declares only pattern-legal property names, assembles the OData form, and calls `microsoft-graph___listSharedMailboxMessages` back through this gateway with SigV4 rather than calling Graph directly, because the Graph credential lives in the OAuth2 provider with no Lambda-readable copy. Cedar permits both the wrapper and the inner action.                |
| `notices`               | Lambda (notices table)                        | `notice_tool_enabled`                        | `search_notices(counterparty, fund, reference, amount, amount_tolerance, date_from, date_to, notice_class, activity_type, limit)` — the EXPECTED side's counterpart. Returns extracted notices only: the table also holds tracking-only rows for documents that produced none, and `_matches` excludes them, so a failed extraction is never returned as reconciliation evidence. A field this notice's class never extracts comes back in `fields_unavailable`, which is **not** a non-match; empty `rows` means searched-and-found-nothing; a read failure raises. |
| `contacts`              | Lambda (contacts table)                       | `contact_tool_enabled`                       | `list_contacts(kind, active_only)` — who the platform may email. Read-only, and **addresses are never returned**: the model cites a `contact_id`, resolved at send time.                                                                                                                                                                                                                                                                                                                                                                                             |
| `templates`             | Lambda (templates table, same Lambda)         | `contact_tool_enabled`                       | `list_templates(purpose, active_only)` — the wording the platform may send. Read-only; subject/body bytes are never returned. Two targets in front of one Lambda on purpose: the gateway composes `<target>___<tool>`, so a combined target would expose `contacts___list_templates`, which the Cedar permit and both allowlists silently fail to match.                                                                                                                                                                                                             |

#### The Graph target in detail

Auth is the configured Entra app (client-credentials, `auth_mode` pinned in
`environments/recon/main.tf`), holding admin-consented **application** `Mail.Read` and `Mail.Send`,
so both send and read are live. The mailbox comes from `graph_mailbox` / `GRAPH_MAILBOX` and has to
be a real mailbox in the tenant. None of these ops are confidence-gated, because OpenAPI ops carry no
`confidence` argument for Cedar to compare against; `sendSharedMailboxMail` is gated at the REQUEST
interceptor instead, which rejects any send without a valid `confirmationToken` and a `sendPurpose`
whose conditions hold.

`getUserProfile` and `searchSharePointSites` are denied by **Cedar, not by Graph**: `cedar_reads`
permits exactly nine actions and omits both, and the engine denies by default, so a call returns
`No policy applies to the request (denied by default)` and never reaches Graph. Don't read that as a
missing permission grant.

`sendSharedMailboxMail` reaches the model on neither backend — a design choice, not a technical limit,
since its argument names are all pattern-legal. The model cites a recipient and a wording BY ID in
`submit_proposal`'s `email_draft` (`recipient_contact_id`, `template_id`, `variables`), the platform
renders it, an analyst approves a specific revision, and the BFF sends that text.

`listSharedMailboxMessages`, as the gateway advertises it, reaches the model on neither backend: its
`$`-prefixed OData arguments surface as tool-schema property names and violate Bedrock's
`^[a-zA-Z0-9_.-]{1,64}$` pattern. The model always goes through a `search_correspondence` wrapper (the
runtime's in-process one, or the `correspondence-search` target), and on the harness the raw op sits in
the decorative `GATEWAY_TOOLS` list while being deliberately absent from the enforced `ALLOWED_TOOLS`.
The op wants `$top` an integer and `$search` a double-quoted string, which the interceptor normalizes:
a `$top` of `"3"` is coerced and the read succeeds.

One naming trap: the runtime registers its in-process wrapper under the raw op name as a
tolerant-matching alias (`strands_investigator.py`), so
`microsoft-graph___listSharedMailboxMessages` in a runtime model's tool list means the clean
`query`/`top` wrapper, not the raw Graph schema.

---

## Agent evaluation & optimization

The harness emits OTel traces and a continuous evaluation pipeline scores them: four online
evaluators at 100% sampling, managed prompt/tool-description recommendations, and a versioned
config store with rollback. Both Tier-2 backends read one shared policy-core prompt, so switching
`agent_backend` cannot change the agent's policy. Full account, including client → agent trace
continuity, in **[assets/agent-evaluation.md](assets/agent-evaluation.md)**.

---

## Frontend tabs

The Trade Reconciliation app's tabs. The Deal Pipeline app's screens (inbox, deals, assistant — with
the Memory Manager as a panel inside it — skills, config) are listed in §10 of
[`docs/deal-pipeline-design.md`](docs/deal-pipeline-design.md). Console-wide settings — access
groups, app enablement, console defaults, each user's preferences — are on the shell's Settings
screen, not in either Config tab; see
[Console-wide configuration](#console-wide-configuration).

| Tab             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**   | Lifecycle status counts across all cases; click-through to filtered history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Queue**       | Open exceptions (PENDING / IN_PROGRESS / PROPOSED); class, confidence meter; multi-select bulk actions; click-through to case detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Case detail** | IDP document split view (section ⇄ page images + extracted fields), classification + reasoning, evidence score with one row per prescribed step, the notices the investigation matched (expandable to every extracted field beside the source document they were read off), the skill that drove the score, proposed resolution, agent trace (tool calls + evidence), approve/disapprove with comments                                                                                                                                                                                                                                                                                                                                               |
| **Documents**   | Every document the pipeline reached a terminal status on, from recon's **own** notice store (the hook writes each row at ingest), newest-first and paged off a GSI over ingest time; sections, confidence alerts, and the config version each ran under — `?` where recon captured none, `≈` on a start time derived from a business date; source bytes stream from the pipeline's input bucket, never copied into recon storage; failures, and documents recon could map no notice from, appear as tracking-only rows carrying the reason, so none vanishes silently; `Object status`/`Evaluation` are a snapshot at extraction, and no human-review information exists — the event carries none, so **Pipeline reports** links out instead; upload |
| **Skills**      | Browse/create/edit/delete SKILL.md files (live, ~60 s). Each tile shows tools; click opens read-only (Edit is explicit). System prompt also editable here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Lessons**     | Captured analyst decisions/corrections fed back to the agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Evals**       | Last-7-days evaluation metrics; on-demand batch; managed recommendations; versioned harness-config (save/deploy/rollback)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Config**      | Toggle Tier-1 (with inline read-only source); set/disable auto-resolve threshold (rewrites Cedar); switch agent backend runtime↔harness (with inline code viewer / harness skill list); model selection; the email contact list and templates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Authentication

`auth_provider` (Terraform) becomes both `AUTH_PROVIDER` on the console task, which the BFF verifies
tokens with, and `NEXT_PUBLIC_AUTH_PROVIDER`, a **build argument** the browser bundle is compiled
with. Three providers, and the two halves resolve the default identically so they cannot disagree —
`src/lib/auth/provider.ts` in the browser, `resolveApiAuth` in `src/lib/api-auth.ts` on the server:

| Value                  | Browser sign-in                                                                                                             | What it needs                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **`cognito`** (default) | An Amazon Cognito user pool's hosted UI, OAuth authorization code + **PKCE**, written against the platform `crypto` and `fetch` with no SDK (`src/lib/auth/cognito-pkce.ts`, gate `src/components/CognitoAuthWrapper.tsx`, redirect route `/callback`) | **Nothing external.** `infra/modules/console-auth` creates the pool, its hosted-UI domain, one public app client and the five groups |
| `okta`                 | Okta OIDC redirect flow (`@okta/okta-auth-js`), redirect route `/login/callback`                                             | An Okta org, `okta_issuer` + `okta_client_id`, and an org admin to register the callback |
| `entra`                | Microsoft Entra ID via MSAL, returning to the app's own origin                                                               | An Entra tenant, `entra_tenant_id` + `entra_client_id`, and a manifest that releases the group claim |

**Cognito is the default because a sample has to be runnable.** This repo is deployed by people into
their own accounts, and both external providers need a tenant nobody has on a first apply — so the
console could not be opened at all until one was obtained. A user pool is a resource the same
Terraform creates, and Well-Architected SEC02-BP04 names Amazon Cognito for
["users of your applications"](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_identities_identity_provider.html).
Okta and Entra are unchanged and fully supported: name one in `auth_provider` and the pool is not
created at all. The only thing this default changed for them is which provider applies when the
variable is **unset**.

**Where the pool comes from, and why not `modules/foundation`.** A Cognito user pool used to live in
`infra/modules/foundation` and was deleted deliberately: it existed **only** to be the intake HTTP
API's JWT issuer while the console itself signed in through Okta, which is one deployment with two
identity providers and a hosted UI nobody ever logged in to. That critique was right, and this is not
a revival of it — the pool is now the console's **actual login**, and the same pool issues the tokens
the intake API's authorizer validates (`local.oidc_issuer` / `local.oidc_audience` in the root), so
there is exactly one identity provider serving every door. It lives in its own module rather than back
in `foundation` so that `foundation` keeps the shape it was left in: S3 + DynamoDB + SSM, with no
identity provider in it. Two things stay as they are: `foundation` remains Cognito-free, and the
VPC-only **private** intake REST API (`infra/modules/intake/private_api.tf`) stays SigV4-authorized —
there is deliberately no IdP in that path, because a Lambda authorizer verifying pool tokens would
have to fetch the JWKS from inside the VPC and would fail closed the moment the NAT is removed, which
is the deployment that API exists for.

What the pool is configured with, and what to change for a deployment that is not a trial: admin-create
users only (**no self sign-up** — a stranger who finds the hosted UI gets a form and no way to make an
account), email as the sign-in name, a 12-character password policy requiring all four character
classes, TOTP MFA `OPTIONAL` (set `cognito_mfa_configuration = "ON"` before any real data), Cognito's
own email sender (capped at 50 messages a day per account; wire SES for more), token validity of 60
minutes with a 1-day refresh, token revocation on, `prevent_user_existence_errors` on, and
`deletion_protection` `INACTIVE` so the sample can be destroyed again.

`UserMenu` (`src/components/app-ui/UserMenu.tsx`, shared by both apps' headers) shows the signed-in
user and a Logout button for whichever provider is active. The intake HTTP API's JWT authorizer
validates the **same** provider — issuer and audience are derived from `auth_provider` once, in the
root module's `oidc_*` locals — so the API and the BFF accept identical tokens. That authorizer, the
two routes behind it, the VPC-only SigV4 door and the `POST /items` contract are in
**[assets/intake-http-api.md](assets/intake-http-api.md)**.

Which apps a signed-in user may open, and where they are an admin, comes from the token's group claim
(`AUTH_GROUPS_CLAIM`) matched against the four `*_ACCESS_GROUP` / `*_ADMIN_GROUP` variables (or the
values a console admin stored over them from the Settings screen), and whether they may edit
console-wide settings against `CONSOLE_ADMIN_GROUP`, which is environment-only — see
[Two applications, one console](#two-applications-one-console). `AUTH_GROUPS_CLAIM` has **no literal
default**: the root resolves a blank one to `cognito:groups` under Cognito and to `groups` under Okta
and Entra, because a user pool emits its group memberships as the reserved claim `cognito:groups` and
will not let you rename it. A hard-coded `groups` default would have been silently wrong in the worst
possible way — every token would verify, every group list would come back empty, and every user would
be denied every app with nothing anywhere saying why.

`ALLOW_ANONYMOUS_API=true` is the local-dev switch that replaces token verification with a single
anonymous subject holding every configured group (or the ones in `ANONYMOUS_GROUPS`);
`RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API` are the same switch under each app's
older name. None of the three may appear in a deployment.

#### Bringing your own identity provider: federate it INTO the pool

The supported way to keep a corporate directory is **not** to switch `auth_provider`. Add a SAML or
OIDC identity provider to this pool (`aws_cognito_identity_provider`) and name it in
`cognito_supported_identity_providers` **alongside `"COGNITO"`** — adding the provider resource alone
does not make the sign-in page offer it, and dropping `"COGNITO"` from the list disables local pool
users entirely. The corporate directory then becomes an upstream of the pool: the console still signs
in through one hosted UI, the BFF still verifies **one** issuer and one token format, and the intake
API's authorizer needs no change at all. This is the arrangement AWS documents —
[Adding user pool sign-in through a third party](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html).

⚠️ **Only half of that recipe is parameterised, and the README used to leave this unsaid.**
`cognito_supported_identity_providers` is a real tfvars knob, but `infra/modules/console-auth` declares
only four resource types — the pool, its domain, the app client and the five groups — and **no
`aws_cognito_identity_provider`, with no variable that would create one**. So federating a directory
into this pool takes one code edit, and there is no configuration-only path to it today. The shallower
of the two ways to make that edit is to add the resource in the **root** (`infra/environments/recon`)
against `module.console_auth[0].user_pool_id`, rather than forking the module; a `map(object(...))`
input on `console-auth` is the proper fix and is not there yet.

Two values your identity team will ask for, both already available as outputs:

| They need                      | It is                                                            | Read it from                                        |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| ACS / reply URL                | `https://<hosted-ui-host>/saml2/idpresponse`                     | `terraform output cognito_hosted_ui_url`, plus the path |
| SP entity ID / audience URI    | `urn:amazon:cognito:sp:<pool-id>`                                | `terraform output cognito_user_pool_id`               |

And one prerequisite that fails at **first sign-in** rather than at apply, which makes it easy to miss:
this pool sets `username_attributes = ["email"]`, so `email` is a required attribute and the IdP must
send an `email` claim in the assertion **and** you must map that claim to the attribute for the
provider. Both the URL formats and the `email` requirement are in
[Configuring your third-party SAML identity provider](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-integrating-3rd-party-saml-providers.html).

⚠️ **One thing is not true out of the box, and it is the thing that breaks per-app authorization.**
`cognito:groups` carries only groups that exist **in the user pool** — the five this stack creates,
plus the one Cognito creates automatically for each federated provider you add (named
`<pool-id>_<IdP name>`, which auto-generated federated profiles join, though linked users do not). A
group from the upstream directory — an Okta group, an Entra security group — **does not appear in
`cognito:groups` at all**, so a federated user signs in successfully and lands in the no-access state.
Carrying those memberships into the token takes one of two extra steps:

- **Attribute mapping.** Map the incoming SAML attribute or OIDC claim onto a custom user-pool
  attribute, which is emitted as `custom:<name>` — then set `auth_groups_claim = "custom:groups"` so
  the console reads the claim you actually mapped to. See
  [Specifying identity provider attribute mappings](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html).
  The trap here is size: Cognito caps any attribute at 2,048 bytes
  ([Quotas in Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html)),
  which is a real ceiling for a group list rather than a theoretical one — AWS ships a *Truncate large
  attributes* inbound-federation example for exactly this case. Measure the raw value your directory
  sends before relying on a straight mapping; we have not measured yours.
- **An inbound federation Lambda trigger.** The trigger AWS built for exactly this case: it runs
  *during* federation, before Cognito creates or updates the federated profile, and can add, override or
  suppress attributes — AWS's own documented examples are group-membership management and truncating an
  over-long attribute. It is the right answer when the directory's group list is large or the mapping is
  not one-to-one. See
  [Inbound federation Lambda trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-inbound-federation.html).
- **A pre token generation Lambda trigger.** Version 1 of that trigger can override
  `groupsToOverride`, which sets `cognito:groups` itself, or add an arbitrary claim to the ID token —
  useful when the decision has to be made per token rather than per federated profile. See
  [Pre token generation Lambda trigger](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html).

`infra/modules/console-auth` attaches **no** Lambda triggers and exposes no variable for one, so either
of the last two options is a second code edit alongside the provider resource.

However you do it, `auth_groups_claim` must name whichever claim the groups end up in, and the names
inside it must match the five console group names — which, for a federated deployment, is the argument
for setting the four `*_group` variables and `console_admin_group` explicitly rather than inheriting the
pool's own names.

One thing here works better than a reader would guess: **an identity provider you add out of band
survives every subsequent apply.** The callback patch (`enable_cognito_callback_patch`) reads the live
app client and rebuilds the update request by *exclusion* — it replaces only `CallbackURLs` and
`LogoutURLs` and writes every other field back as found — so it cannot clobber
`SupportedIdentityProviders`. And the client's `lifecycle { ignore_changes }` covers only those same two
URL lists, so a change to `cognito_supported_identity_providers` does take effect on the next apply.

#### What it costs

Amazon Cognito user pools are **free for the first 10,000 monthly active users who sign in directly**
with pool credentials. Users who sign in through **SAML or OIDC federation are metered separately**:
there is a 50 MAU free allowance and they are billed per MAU above it. So the federated arrangement
above is the one with a bill attached at even small scale, and it is worth knowing before choosing it
over local pool users for a demonstration.

Three further points, all easy to get wrong:

- **Both allowances are per account _or per AWS organization_.** The pricing page says so in as many
  words, so a member account in a large organization does not get its own 10,000 and 50 — the
  organization's may already be spent. Worth checking before quoting "free" to anyone.
- **A "monthly active user" is not only a sign-in.** Creating a user, verifying an attribute, changing
  group membership and an admin `AdminGetUser` query all count, which matters if anything automates
  the pool. AWS enumerates them under
  [Monthly active users](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html).
- **Feature plans decide the per-MAU price and which features exist.** `managed_login_version = 1`
  (this module's default) is the *classic hosted UI*, which the Lite plan includes; **managed login**,
  the newer branded sign-in experience, needs the **Essentials** plan. `infra/modules/console-auth`
  does not set `user_pool_tier` at all, so the pool is created on whatever the service's default plan
  is — Essentials, for pools created today. Compare the plans under
  [User pool feature plans](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html)
  and read the current numbers off the [Amazon Cognito pricing page](https://aws.amazon.com/cognito/pricing/)
  rather than from here.

---

## Networking

All recon backend compute runs inside the VPC on private subnets (`infra/modules/network`). The
Lambdas are VPC-attached with a shared egress-only security group, and the AgentCore Runtime uses
`network_mode = VPC` on the same subnets and SG. Gateway VPC endpoints cover S3 and DynamoDB;
interface endpoints for `ecr.api`, `ecr.dkr` and `logs` handle container image refresh and logging
without leaving the VPC. A single NAT gateway carries the remaining AWS API egress: Bedrock, SSM, the
AgentCore control plane.

Two components sit outside that shape:

- **AgentCore Gateway.** No gateway-level VPC attribute exists (confirmed July 2026), so both
  gateways are managed public endpoints behind AWS_IAM, and targets are invoked via the gateway's own
  IAM role.
- **Frontend.** In the deployed dev environment the ECS/ALB tier is cost-optimized: the Fargate task
  runs in dedicated public subnets with `assign_public_ip = true`, pulling its image and reaching
  CloudFront and AWS APIs directly with no NAT, locked down by security groups and fronted by the
  ALB. The next section describes the hardened private-VPC alternative.

CloudFront is the only internet entry point, since the ALB's sole port-80 ingress is the CloudFront
managed prefix list, so it carries a WAFv2 web ACL (`aws_wafv2_web_acl.frontend` in
`infra/modules/frontend-ecs`) with `AWSManagedRulesCommonRuleSet` and a default action of allow. That
default is deliberate: this is a filter in front of an already-authenticated app, not an allowlist
perimeter. `SizeRestrictions_BODY` is overridden to count, because real config-save and proposal
bodies exceed its 8 KB limit.

A `CLOUDFRONT`-scoped ACL has to be created in us-east-1, and the module inherits the root provider,
so a `lifecycle.precondition` asserts `var.region == "us-east-1"` rather than failing later with an
opaque WAF error. In private-VPC mode the ACL is `count = 0`, since there is no distribution to attach
it to. No rate-based rule is configured on the ACL, so request-rate abuse is unmitigated at the edge.

---

## Private VPC deployment

`terraform apply -var="private_vpc=true"` switches the whole topology in one change: internal ALB,
Fargate on private subnets with no public IP, no CloudFront, and fourteen PrivateLink interface
endpoints so nothing needs the NAT. The NAT itself survives the flag — removing it is a follow-up
edit. The three ingress options, the endpoint set and why `bedrock-agent-runtime` is deliberately
absent, and the private-mode architecture diagram are in
**[assets/private-vpc-deployment.md](assets/private-vpc-deployment.md)**.

---

## Installing into an existing, governed AWS account

Everything above assumes what this repository was built to assume: **a sandbox account it effectively
owns, in us-east-1, with a default VPC in it.** That is the right assumption for a sample whose job is
to be deployable in an afternoon, and it is the wrong assumption for the account most enterprises would
actually put it in. This section is the honest inventory of the difference. It is written so that you
can decide, before you spend a day on it, which of these you can absorb and which one is a fork.

Nothing here is a criticism of a governed account's controls. The controls are correct; the sample
simply does not offer the inputs they require yet. Where that is so, this section says what the change
would be rather than pretending a variable exists.

| Requirement of your account                        | Where this sample stands today                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **No default VPC** (typical of AWS Control Tower)  | **Blocked, at plan time.** There is no `vpc_id` input, and the default VPC is read unconditionally. See below — this is the one hard stop |
| **Bedrock model access managed centrally**         | Works, but undocumented until now, and needs `aws-marketplace:*` plus an Anthropic first-time-use submission                             |
| **A region other than us-east-1**                  | Blocked by two pins — one fails loudly at plan, one at apply — plus a third that is a pin to the US *geography* and surfaces only at the first model invocation |
| **An existing Terraform state bucket, KMS-CMK encrypted** | Import path documented; the bootstrap root sets `AES256` only, so a mandatory-CMK control fails there first                       |
| **A resource-naming standard**                      | Mostly satisfied by `name_prefix`; two S3 bucket names are the exception                                                              |
| **Permission boundaries or an IAM path on every role** | **Not supported.** Neither argument appears anywhere in `infra/`                                                                    |
| **Mandatory tags**                                 | Six lines in the root fixes it, with no module edits                                                                                    |
| **Your own workforce identity provider**           | Federating it *into* the pool this stack creates works, and costs one code edit. Pointing at a pool you already own is not supported     |

### 1. Networking — a default VPC is a hard prerequisite today

`infra/environments/recon/main.tf` reads the account's default VPC at the root level, with no `count`:

```hcl
data "aws_vpc" "default" {
  default = true
}
```

Both consumers of it — `module.network` and `module.frontend` — are count-gated by the tier flags, so it
is tempting to assume the cheap development profile is VPC-free. **It is not.** A root-level `data`
block is read during every refresh regardless of whether any surviving resource consumes it, so in an
account with no default VPC *every* invocation fails there: plan, apply, and the cheap profile with all
five `enable_*` flags off. It fails before a single resource is evaluated, which at least means it fails
in seconds and costs nothing.

Supplying a VPC id is necessary and **not sufficient**, and this is the part to budget for. Three more
things are hardcoded to the *shape* of a default VPC, in module variable defaults the root never
overrides:

| Hardcoded                                                                              | Where                                                        | Why it breaks in a landing-zone VPC                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `private_subnet_cidrs = ["172.31.110.0/24", "172.31.111.0/24"]`, `nat_subnet_cidr = "172.31.108.0/24"` | `infra/modules/network/variables.tf`                         | `172.31.0.0/16` is the default-VPC range. A 10.x VPC rejects them as not inside the VPC       |
| `public_subnet_cidrs = ["172.31.100.0/24", "172.31.101.0/24"]`                          | `infra/modules/frontend-ecs/variables.tf`                    | Same, and equally not overridable from the root                                              |
| `availability_zones = ["us-east-1a", "us-east-1b"]`                                     | both of the above                                            | Pins the stack to us-east-1 even though `var.region` looks free                              |

Both modules also require the VPC to have an **attached internet gateway** (`data
"aws_internet_gateway"`, filtered on the VPC id), which many landing-zone workload VPCs do not have
because egress runs through a shared inspection VPC. And the stack **writes into** whatever VPC it is
given: three subnets, two route tables, a route to the IGW, an EIP and a NAT gateway. In a landing zone
where the network team owns that VPC's route tables, that is an unauthorised change and not merely a
configuration mismatch.

There is no supported path to a customer-supplied VPC at all right now: `private_vpc = true`, the
closest thing, is cross-validated to *require* `enable_private_networking = true`, and the frontend's
private subnet ids only ever arrive from `module.network`, never from a variable.

**Plan for a networking fork, not a tfvars change.** The smallest honest sequence is: a `vpc_id`
variable with a `count`-gated default-VPC lookup behind it (which unblocks plan); then the four CIDR and
AZ inputs surfaced as root variables (without which you have only moved the failure from "no VPC found"
to "CIDR not in VPC"); and then, if the network team owns the subnets, an `existing_*_subnet_ids` pair so
the modules consume subnets instead of creating them — which makes the NAT, route-table and IGW
resources conditional and is genuinely the largest of the three.

### 2. Bedrock model access

Nothing in this repo mentions Bedrock model-access prerequisites, and in a governed account they are the
likeliest cause of a green apply followed by an agent that only returns `AccessDeniedException`. AWS's
[Request access to models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
states the current requirements:

- The invoking IAM role needs `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and
  `aws-marketplace:ViewSubscriptions`. **`aws-marketplace:*` is one of the more commonly SCP-denied
  namespaces in a member account**, so check this first.
- For Anthropic models you must complete the First Time Use form before invoking — "once per account or
  once at the organization's management account", and a submission at the management account is
  inherited by the organization. A member-account operator may not be able to do this themselves.
- The account needs a valid AWS Marketplace payment method.
- The failure mode is unkind: during a subscription setup period of up to 15 minutes calls **may succeed
  temporarily**, and if a prerequisite is missing the subscription fails and subsequent calls return
  `AccessDeniedException`. So a smoke test that passed once is not evidence.

Compounding it: the default model id everywhere in this stack is `us.anthropic.claude-sonnet-5`, a **US
geographic cross-Region inference profile**. Such a profile routes inference to any of its destination
Regions, and **you need model access in each of them**, not only in your deployment Region. The
destination list is per profile — read it off
[Supported Regions and models for inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
or the model's own detail page rather than assuming. A single-Region model id avoids this at the cost of
the throughput headroom the profile exists to give.

### 3. Region availability

`region` is documented as an ordinary variable with a default of `us-east-1`. Treat that as a floor,
not a choice. Three independent things hold this stack in the US, and only the first two hold it in
us-east-1 specifically:

1. **A `lifecycle.precondition` in `infra/modules/frontend-ecs` asserts `var.region == "us-east-1"`**,
   because a `CLOUDFRONT`-scoped WAFv2 web ACL must be created there and the module inherits the root
   provider. This one fails loudly at plan, with an error message that says so.
2. **The hardcoded `us-east-1a` / `us-east-1b` availability zones** in §1 — these fail at apply, not at
   plan, which is worse.
3. **The `us.` inference profile** in §2 — a pin to the US *geography*, not to us-east-1 (a `us.`
   profile is callable from more than one US source Region; the destination list is per profile and per
   model, so read it off the model's detail page). It is also the only one of the three that **nothing
   validates**: `pipeline_agent_model_id`, `pipeline_memory_model_id` and `harness_model_id` are plain
   strings with no `validation` block (`infra/environments/recon/variables.tf:347,358,565`), so a
   wrong-geography deployment plans and applies cleanly and the agent then fails on its first
   `InvokeModel` with an access-denied or validation error.

AgentCore itself is not the constraint. Its
[supported Regions table](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
listed 22 Regions when this was written, with Gateway, Identity, Observability, Policy and Evaluations
in all 22 and Memory in 16;
**AgentCore Runtime Instances** is the narrowest feature this stack needs, and at the time of writing
that table shows it in US East (N. Virginia), US East (Ohio), US West (Oregon), Europe (Frankfurt),
Europe (Ireland), Asia Pacific (Mumbai), Asia Pacific (Singapore), Asia Pacific (Sydney) and Asia
Pacific (Tokyo). So a customer who wants eu-west-1 can have it from AgentCore's side and would still be
stopped by items 1 and 2 above — at plan and at apply — and then, if they got past those without also
changing the model id, by item 3 at the agent's first invocation. Check that table rather than this
paragraph — it changes.

**Commercial partition only.** There are 98 hardcoded `arn:aws:` strings across `infra/modules/**` and
the root, including an AWS-managed policy ARN and the Cedar principal matchers, so AWS GovCloud (US) and
China are out of scope for this sample as written. AgentCore's own table does list GovCloud (US-West) for
several features, so this is a limitation of the sample and not of the service.

### 4. The Terraform state bucket

`infra/bootstrap` keeps local state by design — it cannot use the bucket it is creating as its own
backend — and names the bucket `${project_name}-tfstate-${account_id}`, with `project_name` defaulting
to `recon-dev`. Two things matter in a governed account:

- **It encrypts with `AES256` only.** No CMK, no bucket key, no lifecycle rule on noncurrent versions. An
  account with a mandatory-KMS control fails here first, before anything else in this repo runs. Either
  add a `kms_master_key_id` to that resource or skip the bootstrap root entirely and point `backend.hcl`
  at a bucket your platform team already manages.
- **If you already have a state bucket, import it** rather than applying over it — a plain apply answers
  `BucketAlreadyOwnedByYou` instead of adopting it. The four `terraform import` commands are in
  [step 1](#1-bootstrap-the-terraform-state-bucket-once-per-account). Skipping the import is not free:
  an unimported bucket has no Terraform source, so drift in its versioning, encryption or public-access
  settings appears in no plan.

### 5. Naming and uniqueness

`name_prefix` carries almost the whole naming standard: change it and the tables, roles, parameters,
repositories, clusters, security groups and AgentCore resources all follow. Two exceptions:

- **The two `foundation` buckets have no account suffix** — `${name_prefix}-raw` and
  `${name_prefix}-assets`. S3 names are globally unique, so these are the reason `name_prefix` must be
  globally unique too, and the reason the shipped default cannot be applied by anyone (see
  [step 2](#2-create-the-two-local-config-files)). `foundation` is the outlier here rather than the
  pattern: every other bucket in the repo — the frontend source and CloudFront-log buckets, the pipeline's
  assets bucket, the state bucket — already appends `${account_id}`.
- **`cognito_hosted_ui_prefix`** is globally unique by nature and correctly has no default, so it is not a
  defect; it is just one more name to coordinate.

**A second deployment in the same account** collides on nothing if it uses a different `name_prefix`, and
on almost everything if it reuses one — the tables, every SSM parameter under `/${name_prefix}/`, every
IAM role name, the ECR repository, the ECS cluster, the CodeBuild projects, the security group, and the
AgentCore Policy engine and Memory (whose names are `name_prefix` with hyphens replaced by underscores,
and which the module's own comments tell you to import rather than recreate).

### 6. IAM permission boundaries and role paths

There are **32 `aws_iam_role` resource blocks** in `infra/modules/**`. Exactly one carries a `count`
of its own (`infra/modules/agentcore-memory/main.tf:26`, on `create_execution_role`); what removes the
rest from a smaller apply is the tier flags gating whole MODULES in the root, so a default apply
creates about thirty roles and the deal pipeline adds two
(`infra/modules/deal-pipeline/lambdas.tf:57,205`). `infra/modules/recon-agent` alone declares
eight. And:

- `permissions_boundary` appears **zero times** in `infra/`.
- `path` appears **zero times on any IAM resource** (the three matches in the tree are an ALB health
  check and two filesystem paths).

There is no provider-level default for either argument, so if your account mandates them this is not
configurable today. **Two outcomes, and the quiet one is the more likely:**

- With a **preventive** control — an SCP or boundary-enforcing policy that denies `iam:CreateRole` unless
  `iam:PermissionsBoundary` matches or a path prefix is used — the apply fails at the first
  `aws_iam_role` Terraform reaches. *Which* one is not deterministic: Terraform walks ten nodes in
  parallel and several roles depend only on data sources. The consolation is that it fails within the
  first minute, before any container build.
- With a **detective-only** control — an AWS Config rule, a Security Hub control, a drift report — the
  apply **succeeds** and leaves about thirty roles at the IAM root path with no boundary. This is the
  worse outcome and it is the more common enterprise setup.

Adding both arguments means two root variables mirrored onto the roughly twenty modules that declare a
role, and one line each on 32 resource blocks. Inline `aws_iam_role_policy` needs nothing. Two things to
know while you do it: check that `iam:AttachRolePolicy` is permitted, because `infra/modules/frontend-ecs`
attaches the AWS-managed `AmazonECSTaskExecutionRolePolicy`; and note that a role **path** changes the
role ARN's shape, which the Cedar principal matchers in `infra/modules/recon-agent` build by string. Those
matchers survive a path only because of a `like "*<role>*"` fallback disjunct beside the exact-ARN
comparison — so authorization keeps working, but by substring match rather than by the equality the
policy appears to rest on. Worth a look before you rely on it.

### 7. Mandatory tagging

**The stack is essentially untagged, and the recon root's provider block is three lines with no
`default_tags`.** Of 271 resource declarations across `infra/modules/**` and the root, **14** carry a
`tags` argument, and nine of those are `Name`-only tags in `infra/modules/network`. Modules `foundation`,
`recon-agent`, `intake`, `deal-pipeline`, `gl-mock` and `tier2-dispatch` have none at all. Only two
modules accept a `tags` variable, and the root passes tags to neither.

The good news is that this is the cheapest item on the list to fix, and it needs **no module edits**:

```hcl
# infra/environments/recon/variables.tf
variable "default_tags" {
  description = "Tags applied to every resource the AWS provider can tag."
  type        = map(string)
  default     = {}
}

# infra/environments/recon/providers.tf
provider "aws" {
  region = var.region
  default_tags {
    tags = var.default_tags
  }
}
```

Two caveats to carry into a compliance conversation. `default_tags` reaches only resources the AWS
provider tags, so it does not reach the inner resources of the CloudFormation-managed AgentCore harness
stack (`aws_cloudformation_stack`). And a tagging SCP that denies untagged `ec2:CreateSubnet` would be
satisfied by the block above, while a Config rule that scans every resource type may not be.

### 8. Identity — three routes, and what each costs

The console and the intake HTTP API deliberately share one identity provider, chosen by `auth_provider`
and resolved once into the root's `oidc_*` locals, so whichever route you take there is exactly one
issuer and one token format in the deployment. What differs is where the directory lives, and — in every
federated case — how group memberships reach the token.

| Route                                                       | Supported today                       | What it costs you                                                                                            |
| ----------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **1. Federate your directory into the pool this stack creates** | Yes, with one code edit           | An `aws_cognito_identity_provider` you add yourself, a group-claim mechanism, and a federated-MAU bill           |
| **2. Point the console at a user pool you already own**     | **No. There is no input for it**      | Would be about four root variables and one `count` — see below                                                  |
| **3. `auth_provider = "okta"` or `"entra"` directly**        | Yes, fully                            | You create the five groups and register the callback by hand; the seeding scripts and the demo users go away     |

**Route 1 — federate your directory into the pool, which is what we recommend.** This is the arrangement
AWS documents, it keeps one issuer, and the intake API's authorizer needs no change. It is described in
full under [Bringing your own identity provider](#bringing-your-own-identity-provider-federate-it-into-the-pool),
including the two values your identity team will ask for (the ACS URL and the SP entity ID), the `email`
attribute mapping that is a prerequisite, the three ways to get group memberships into the token, and the
one code edit that is unavoidable because `infra/modules/console-auth` contains no
`aws_cognito_identity_provider` and no variable that creates one. Read that section before choosing this
route; the rest of this list assumes you have.

**Route 2 — an existing user pool: not supported today, and the gap is only in the Terraform.** There is
no `existing_user_pool_id` input at any layer, and `module.console_auth` is gated only on
`auth_provider == "cognito"` — so choosing Cognito *always* creates a pool, a hosted-UI domain, an app
client and five groups. What makes this worth stating precisely is that **everything below the Terraform
boundary already works against someone else's pool**: the BFF derives the issuer arithmetically from
region and pool id (`cognitoIssuer` in `chatbot-app/frontend/src/lib/api-auth.ts`), reads
`COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` from its environment, and has no idea who created the
pool. Only the root's wiring assumes it. Closing the gap means four `cognito_existing_*` variables
defaulting to `""`, a `count` on `module.console_auth`, and a local that prefers the supplied values at
the seven places the root reads the module's outputs (the intake authorizer's issuer and audience, the
console task's environment, the deploy-actions callback grant, the callback-patch invocation, the outputs
and checklist, and the group-name resolution). Two details a change like that must get right, and they
are the ones that would otherwise ship a silent authorization hole: the five **groups must not** be
created in a pool you do not own, and `enable_cognito_callback_patch` should default to `false` for an
existing pool, because the sample should not hold `cognito-idp:UpdateUserPoolClient` on someone else's
client.

**Route 3 — Okta or Entra directly.** Fully supported and nothing has come to assume Cognito: the intake
API's authorizer takes only an issuer and an audience, the callback patch is count-gated off and the
deploy actor receives an empty pool ARN so no Cognito statement is rendered at all, and the group claim
resolves to `groups` rather than `cognito:groups`. What you gain is a single corporate directory with no
shadow user store, no Cognito MAU bill, group membership maintained where your identity team already
maintains it, and no globally-unique hosted-UI name to claim. Three named losses:

1. **The five groups are not created for you**, and nothing in this repo can create a group in an
   external tenant. You create them in your tenant and release them in the token.
2. **A blank access group means _open_, not _closed_.** Under Cognito a blank resolves to a real, empty
   group and therefore denies; under Okta and Entra it stays `""`, and in a recon-only console that means
   every authenticated user. The stack compensates by refusing the plan when `enable_deal_pipeline = true`
   and either access group is blank — but that validation exempts Cognito, on the premise that the pool
   created the groups. **Set all five group variables explicitly** and the difference stops mattering.
3. **`scripts/create_dev_users.py` becomes inert** (it exits naming `auth_provider`), and with it the
   whole "five demonstration operators" story and the `cognito_first_user_commands` output. You also
   register the CloudFront callback by hand, from the `okta_redirect_uri_to_register` output.

#### AWS IAM Identity Center

If IAM Identity Center is your workforce directory — as it is for many AWS customers — the pattern is
**Identity Center in front of Cognito as a SAML 2.0 identity provider**, with the Cognito pool as the
SAML service provider. You register a customer managed SAML 2.0 application in Identity Center, give
Cognito its metadata URL, and add a `SAML`-type `aws_cognito_identity_provider` to the pool. AWS
publishes this pattern in both directions:

- [How to implement trusted identity propagation for applications protected by Amazon Cognito](https://aws.amazon.com/blogs/security/how-to-implement-trusted-identity-propagation-for-applications-protected-by-amazon-cognito/)
  — its Step 3 is creating exactly this SAML federation trust.
- [Innovation Sandbox on AWS — Authentication mechanism](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/authentication-mechanism.html)
  — an AWS Solution that "authenticates web UI users with Amazon Cognito, which federates to the Single
  Sign-On service from AWS IAM Identity Center using the SAML 2.0 protocol".

The Cognito half is the same as any third-party SAML IdP, so the ACS URL and SP entity ID in
[Bringing your own identity provider](#bringing-your-own-identity-provider-federate-it-into-the-pool)
are what Identity Center needs.

⚠️ **For the group claim, Identity Center is harder than a generic Okta or Entra federation, not the
same.** Identity Center's custom-SAML attribute mapping is defined over **user** attributes: the
supported list in
[Attribute mappings](https://docs.aws.amazon.com/singlesignon/latest/userguide/attributemappingsconcept.html)
is `userName`, names, emails, addresses, `title`, `department` and the like — **group memberships are not
in it**. So the attribute-mapping remedy has nothing to map from, and you cannot solve this with
mappings alone. AWS's own solution demonstrates the consequence: Innovation Sandbox uses this very
Identity Center → Cognito trust and then adds "a Cognito Pre Token Generation trigger [that] resolves
your IAM Identity Center group memberships and adds the corresponding solution roles ... to the token" —
a Lambda that calls the Identity Store API, written precisely because the assertion does not carry the
groups.

For this sample that means an Identity Center customer needs three things, of which only the last exists
today: the SAML provider resource (§8 route 1), a pre token generation or inbound federation Lambda that
resolves Identity Center group memberships to the five console group names, and `auth_groups_claim` set to
whatever claim that Lambda writes — which is already a root variable, and one whose per-provider
resolution yields to an explicit value.

#### The `cognito:groups` gap, for every federated route

This is the single failure mode most likely to cost you an afternoon, so it is worth stating once more on
its own, because **nothing logs it and nothing looks broken**: a federated user signs in successfully,
the token verifies, the group list comes back empty or full of names the console has never heard of, and
they land on the no-access page.

`cognito:groups` carries only groups that exist **in the user pool** — the five this stack creates, plus
the one Cognito creates automatically per federated provider. An upstream Okta group, an Entra security
group, an Identity Center group **does not appear in it**. And under `auth_provider = "cognito"` a blank
group variable silently falls back to the pool's own default names, so a federated user in a group that is
not one of those five is authenticated and entitled to nothing.

Three habits make this survivable:

1. **Set all five group variables explicitly** — `recon_access_group`, `recon_admin_group`,
   `pipeline_access_group`, `pipeline_admin_group`, `console_admin_group` — rather than inheriting the
   pool's defaults, so the names the console checks are names you chose.
2. **Set `auth_groups_claim` explicitly** to whichever claim actually carries the groups: `cognito:groups`
   only if something writes pool groups, otherwise the `custom:*` attribute or the claim your trigger adds.
3. **Verify from the token, not from the plan.** The Settings screen's **Users** tab shows the console what
   it thinks you are — subject, groups, per-app access, console admin or not — and for a console admin its
   *check access* tool answers "which apps would a user holding this set of groups see". That is the
   fastest way to tell an empty group claim from a misnamed group.

### Other things that will surprise a governed account

| Surprise                                                                                                                                                                                                        | Where                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **The apply needs a local toolchain.** Five `local-exec` provisioners run during apply; four of them shell out to `zip`, `aws s3 cp`, `aws codebuild start-build`/`batch-get-builds` in a 30-minute poll loop, a `build.sh`, and a `stage.sh` that runs `rsync -a --delete` and then `pip` with a platform/Python-version pair. `rsync` is the one a minimal image is most likely to be missing. Plan is toolchain-sensitive too, because `archive_file` reads the staged directory at plan time | `frontend-ecs`, `recon-agent`, `lambda-package` |
| **Two privileged Docker builds.** Both CodeBuild projects set `privileged_mode = true` and run on the AWS-managed network with no `vpc_config`, because the builds need the Docker daemon and public npm and pip. A control that denies `privileged_mode` or mandates `vpc_config` on all CodeBuild projects breaks both, and the apply blocks on them — the frontend driver polls for up to 30 minutes (180 × 10 s) before failing | `frontend-ecs`, `recon-agent`               |
| **Internet-facing by default.** With `private_vpc = false` you get a public CloudFront distribution on `*.cloudfront.net` with the default certificate, an internet-facing ALB and an internet-facing intake HTTP API. `private_vpc = true` is the documented alternative — but it requires `enable_private_networking = true`, which requires the default VPC of §1, so in an account that forbids public endpoints the only compliant topology is currently also the unreachable one | `frontend-ecs`, `intake`                    |
| **`force_destroy` on data stores.** Five S3 buckets set `force_destroy = true` — the two `foundation` buckets, the frontend source and CloudFront-log buckets, and the pipeline's assets bucket — plus `force_delete = true` on the agent's ECR repository and `force_destroy = true` on the Athena workgroup. A `terraform destroy` empties all of them without prompting. Right for a sample being trialled; check it before anything you care about lands in them. The state bucket is the deliberate exception, at `force_destroy = false` | `foundation`, `frontend-ecs`, `deal-pipeline`, `recon-agent`, `gl-mock` |
| **`cognito_deletion_protection` defaults to `INACTIVE`.** Deliberate, so a trial can be destroyed. Flip it to `ACTIVE` before the pool's user list matters: recreating a pool changes the token issuer and every `sub`, so the audit trail's author ids stop resolving | `console-auth`                              |
| **A first apply may need running twice.** The gateway-target and Cedar-policy race described in [step 3](#3-deploy). CI that applies exactly once will report a failed first install                             | `recon-agent`                               |

---

## Cost Estimation (caution: AI generated & unverified)

Sample monthly cost for the deployed dev/demo configuration in US East (N. Virginia),
on-demand pricing, no savings plans/free-tier. This is a low-volume demo profile — the
always-on infrastructure (Fargate, NAT, ALB) sets the floor, and Bedrock is the largest single
line even at this volume.

### Assumptions

Volume is low: ~1,000 reconciliation items a month, of which ~300 escalate to the Tier-2 agent while
the other ~700 auto-clear in Tier-1, at roughly 2 investigation and analyst-decision cycles per
escalated item.

The frontend is one always-on ECS Fargate task (0.5 vCPU / 1 GB) behind an ALB, fronted by CloudFront,
with a single NAT gateway, running 24×7.

Bedrock runs Claude Sonnet as both the agent and the LLM-judge model: ~300 investigations at
**~190K input and ~12K output tokens each** (measured off the `token_usage` attribute on real cases —
an earlier estimate of ~50K/~3K was low by roughly 4×, which is what kept the account's
tokens-per-minute ceiling out of view until a burst hit it), plus the online-eval judges (~4
evaluators over sampled sessions). Note the per-investigation figure is `k+1` model calls, not one:
`k` self-consistency classification samples plus the multi-turn investigation loop.

The guidance corpus lives in a **fully managed** Knowledge Base (`type = "MANAGED"`, in
`infra/modules/recon-agent/main.tf`), which owns its own vector store — nothing to size, no
OpenSearch Serverless collection and no OCU floor, and no embedding model of ours to pay for. It is
the only knowledge base — there is no customer-managed S3 Vectors KB alongside it.

DynamoDB, Lambda, S3 and Athena are all on-demand at demo volume.

The Bedrock line was revised upward once real `token_usage` was measured: ~190K in / ~~12K out per
investigation, roughly 4x the original estimate — which is why the account's tokens-per-minute ceiling
stayed out of view until a burst reached it. The dollar figure scales the measured token volume at the
same per-token rate the previous estimate implied (~~$3/M in, ~$15/M out) rather than a fresh price
lookup, so treat it as an order of magnitude. Note it now dominates the bill.

### Estimated monthly cost (demo profile, us-east-1)

| Service                                                                                     | Driver                                                            | Est. $/mo     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------- |
| **Amazon Bedrock — Claude Sonnet**                                                          | ~300 investigations (~57M in / ~3.6M out, measured) + eval judges | **~$225**     |
| **NAT Gateway**                                                                             | 1 gateway (~$0.045/hr) + data processing                          | **~$35**      |
| **CloudWatch** (logs, metrics, Transaction Search spans, Logs Insights)                     | OTel spans + eval queries                                         | **~$25**      |
| **AgentCore** (Runtime/Harness, Gateway, Memory, Evaluations)                               | low invocation volume; consumption-priced                         | **~$20**      |
| **ECS Fargate** (frontend)                                                                  | 1 task, 0.5 vCPU + 1 GB, 24×7                                     | **~$18**      |
| **Application Load Balancer**                                                               | 1 ALB, low LCU                                                    | **~$18**      |
| **WAF** (CloudFront web ACL)                                                                | 1 web ACL + 1 managed rule group + low request volume             | **~$6**       |
| **Secrets Manager / SSM / ECR / CodeBuild**                                                 | few secrets, params, image builds                                 | **~$5**       |
| **Bedrock — Knowledge Base ingestion + `Retrieve`**                                         | seed corpus + retrievals (managed KB owns the embedding)          | **~$3**       |
| **Step Functions** (Tier-2 map run, STANDARD)                                               | ~8,600 scheduled runs/mo + one child execution per case           | **~$1**       |
| **Lambda** (idp-hook, tier1, worker, tier2 dispatch trio, gl, interceptor, evaluator, etc.) | demo invocations, mostly free-tier-adjacent                       | **~$3**       |
| **DynamoDB** (items, cases, audit, lessons — on-demand)                                     | low RCU/WCU                                                       | **~$3**       |
| **S3** (assets, skills, configs, GL, IDP page copies)                                       | few GB + requests                                                 | **~$2**       |
| **CloudFront**                                                                              | low egress                                                        | **~$2**       |
| **Athena** (GL queries via `search_ledger`)                                                 | small scans, $5/TB                                                | **~$1**       |
| **Amazon Cognito** (the console's user pool)                                                | a handful of operators signing in directly, well inside the 10,000-MAU free allowance — see [Authentication](#authentication) for the federated case, which is metered from 50 MAU | **$0**        |
| **Total (demo profile)**                                                                    |                                                                   | **≈ $365/mo** |

_These are rough list-price estimates for planning only. Validate them against the AWS Pricing
Calculator and your actual traffic before relying on them._

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## Authors

- Felix Huthmacher, Senior Applied AI Architect [github - fhuthmacher](https://github.com/fhuthmacher)

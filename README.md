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

---

## Solution Architecture

![Solution Architecture](assets/solution-architecture.svg)

_Full interactive version: [`assets/Solution Architecture.html`](assets/Solution%20Architecture.html)_

![Operator console — every screen, in nav order](assets/img/demo.gif)

The architecture has three planes:

| Plane               | Purpose                                                                                                                                                    | Key services                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Ingestion**       | Email/document intake → unique event id → raw storage → classification → field extraction (Bedrock LLM) → schema validation → per-field confidence scoring | IDP pipeline (Lambda, S3, DynamoDB)                                                                        |
| **Application**     | Human-in-the-loop review frontend + backend API; agent runtime for the Reconciliation Agent                                                                | Frontend (React/Next.js), ECS/ALB, Backend API, AgentCore Runtime/Harness                                  |
| **Shared services** | Tool access, memory, identity, policy, observability, evaluation for all agents; LLM access                                                                | AgentCore Gateway, Memory, Identity, Policy, Evaluation; Bedrock Knowledge Base; Bedrock foundation models |

### High-level architecture components

| Concern            | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points       | The IDP post-processing hook Lambda (`recon-dev-idp-hook`, invoked by recon's **own** EventBridge rule when an IDP document-processing execution reaches a terminal status), and an intake HTTP API (API Gateway + an OIDC JWT authorizer on the same Okta/Entra provider the console uses) for structured datasets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Item / case stores | Five DynamoDB tables: `recon-dev-items` (canonical `ReconItem` inputs — **the only stream-enabled table**, which is what makes writing an item the way to open a case), `recon-dev-cases` (case lifecycle, status GSI), `recon-dev-audit` (append-only status-transition log), `recon-dev-lessons` (analyst decisions: approval, correction, auto-resolution, one row per item+trigger), and `recon-dev-notices` (extracted documents as **evidence**). Operator configuration lives in three more: contacts, email templates and workflow types                                                                                                                                                                                                                                                                                                                                                                                                    |
| Deterministic tier | A Tier-1 Lambda consuming the items stream. Items match within tolerance and items are looked up in a mocked general ledger (Athena over S3) and auto-clear only on an unambiguous attribute match: account name, entry-type direction, and amount within tolerance (toggleable via SSM or the Config tab)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Agent              | Two interchangeable backends selected by the `agent_backend` SSM parameter: an AgentCore Runtime container (Strands `Agent` agentic loop), or the managed AgentCore Harness (config-declared), with the model each one invokes selected by a second parameter (`agent-model-id`), read per invocation. Skills and the system prompt are live from S3, with a ~60 s cache on the runtime and per-session on the harness. Two AgentCore gateways (AWS_IAM/SigV4): the egress tools gateway (9 targets, 6 of them conditional — one is a managed `bedrock-knowledge-bases` **connector** target, the rest Lambda/OpenAPI) with the Cedar Policy confidence gate, and an ingress agent gateway fronting the runtime (one `http/agentcoreRuntime` target of its own). AgentCore Memory holds the `lessons_learned` semantic strategy, and a fully managed Bedrock Knowledge Base holds the guidance corpus, queried with agent-supplied metadata filters |
| Evaluation         | AgentCore Online Evaluation (a custom analyst-agreement evaluator plus 3 builtins) over harness OTel traces, on-demand batch re-scores, managed recommendations, and a versioned harness-config store (immutable S3 docs + SSM pointer). All of it surfaces in the Evals tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Frontend           | Next.js on ECS Fargate behind an ALB and CloudFront, with a WAFv2 web ACL (`AWSManagedRulesCommonRuleSet`) on the distribution, which is the single internet entry point. Okta OIDC login (`auth_provider`, swappable to Entra) and same-origin BFF routes (`/api/recon/*`) running under the task role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Notifications      | Microsoft Graph is the only channel (app-only, from the shared mailbox), reached through the egress gateway's OpenAPI target. It carries resolution emails on approve/auto-resolve (`cases/notify.py` plus the frontend BFF calling `sendSharedMailboxMail` through the gateway with SigV4), counterparty email sent by the BFF from an analyst-approved draft, and mailbox reads (`listSharedMailboxMessages`, reached only through the `search_correspondence` wrapper). No agent holds a send tool on either backend: the model writes the counterparty message into its proposal and a human approves a specific revision of it. Nothing stores an address: a draft and a resolution notice both name a contact id, and the address is read from the contacts table at the moment of sending, so deactivating a contact stops mail to them even if a draft was already approved. Sends are gated at the gateway REQUEST interceptor.            |
| IaC                | Terraform (`infra/`) with S3-backed state. The AgentCore Harness lifecycle is an `aws_cloudformation_stack` (`infra/modules/recon-agent-harness`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Intelligent Document Processing (IDP) decoupling:** Two channels reach the independently-deployed
IDP solution and no others: the completion event recon's own EventBridge rule reads, and the IDP MCP
tool. IDP storage is touched in three sanctioned places, none of them the agent: the hook reads the
output bucket at ingest, to copy extracted field values and page images into the notice; the console
streams a document's raw bytes out of the input bucket for the Documents tab, rather than duplicating
customer financial documents into recon storage; and an extraction upload is put into that same input
bucket. The runtime and the agent never touch IDP storage at all.

---

## Repository layout

```
backend/                Python 3.12 Lambda handlers
  recon_core/           Shared domain: schema, cases, status, confidence, auto_resolve,
                        lessons_recall, errors, skills_s3, otel_client, prompt_source
                        (shared-core + harness-contract composition), and email_policy —
                        the authority on which recipient and which wording a send may carry
  tier1/                DynamoDB stream consumer (opens the case PENDING; dispatches nothing) plus
                        the BLOCKING agent-worker, still used for the harness backend and for the
                        frontend's single-case Retry. Two independent switches, not a flat three-way
                        choice: `harness` vs `runtime` (SSM-backed), and — for `runtime` only —
                        ingress vs direct transport to the same container
  tier2_dispatch/       Async dispatch for the map run: a dispatcher that hands the agent a Step
                        Functions task token and returns in ~1s, a collector that materialises the
                        PENDING list to S3 (a Distributed Map's ItemReader reads S3 only), and the
                        two guarded case writes (claim / mark-failed)
  harness_agent/        Managed-Harness backend: worker, stream, intake, prompting, session, config_store
  gl_tool/              General-ledger read + set_draw_status write (status allowlist only)
  status_tool/          recon-status target: platform-only, state-machine-guarded case-status writes
  gateway_interceptor/  Gateway REQUEST interceptor: write provenance, status-transition re-check,
                        the sendSharedMailboxMail recipient/purpose gate, OData normalization
  notice_tool/          search_notices target over the notices table; `_matches` is the single choke
                        point that excludes tracking-only rows from the agent's evidence
  correspondence_tool/  correspondence-search target: sanitizes the model's arguments into Graph's
                        OData form and re-enters this gateway, keeping the credential in the vault
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

agent-blueprint/
  recon-agent/          AgentCore Runtime container: agent.py, strands_investigator.py, llm.py,
                        classifier.py, proposal.py, gateway_mcp.py, skills_loader.py,
                        skills/*.md, system-prompt.md, Dockerfile
  recon-agent-harness/  Harness blueprint: harness_config.py (tools/schema), system-prompt.md

chatbot-app/
  frontend/             Next.js app: /recon/* pages + /api/recon/* BFF routes. The other api/
                        route groups are inherited scaffolding, non-functional here, and fail
                        loudly naming the missing env var (src/lib/deployment-env.ts)

infra/
  modules/              Terraform modules: foundation, notice-store, contact-store,
                        workflow-types, upload-audit, intake, tier1, idp-hook, email-preprocess,
                        kb-ingest-trigger, recon-agent, recon-agent-harness, agent-evals, gl-mock,
                        api, frontend-ecs, lambda-package, lambda-logs, deploy-actions, network,
                        observability, microsoft-graph-obo
  environments/recon/   Dev environment root (S3-backed state via a partial backend config)
  bootstrap/            Terraform-state bucket bootstrap (local state, import-first)
  scripts/              deploy-recon.sh, push_editable_seeds.py, gen_harness_config_json.py,
                        reset_runtime_data.py, verify_harness_surface.py,
                        evals-provisioning-notes.md

data/                   Synthetic sample documents, mocked general-ledger CSV, the kb-seed
                        guidance corpus, and the tracked IDP extraction config
tests/                  104 pytest test files (moto-mocked AWS); frontend: chatbot-app/frontend/__tests__
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
| Frontend | Next.js 16, React 18, Tailwind CSS, Radix UI, `@aws-sdk/client-bedrock-agentcore`, MSAL / `@okta/okta-auth-js`                                                   |
| IaC      | Terraform (AWS provider `>= 6.62.0, < 7.0.0` — 6.62.0 is the floor for three AgentCore schema features this stack uses), S3 backend                              |
| Agent    | Amazon Bedrock AgentCore (Runtime, Harness, Gateway, Memory, Policy, Evaluation, Identity)                                                                       |
| LLMs     | Claude Sonnet 5 (default for both the runtime and harness backends; selectable per backend)                                                                      |
| Testing  | pytest + moto (backend), vitest + testing-library (frontend)                                                                                                     |

## Getting Started

You need a clone of this repo, Terraform `>= 1.11`, and AWS credentials for the target account. Steps
1 to 3 are one-time setup for a fresh account or a fresh checkout; from then on step 4 is the whole
deployment.

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

`otel_layer_account` declares no default, so both plan and apply stop until it is set. It is AWS's own
public layer-publisher account rather than a secret. See
[Prerequisites & configuration](#prerequisites--configuration) for every variable.

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
ECS service. No second apply, no manual build step. Most of the wall-clock time is CodeBuild.

### 4. Configure Okta OIDC app for sign-in

Register the `okta_redirect_uri_to_register` output as a sign-in redirect URI on the Okta OIDC app,
and `frontend_url` as a sign-out redirect URI. This needs an Okta org admin. Until the callback URI is
registered, login cannot complete and every route stops at `400 invalid_request`.

### 5. Point recon at the IDP document-processing state machine (if applicable)

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

### 6. Optional flips

```bash
# Harness instead of the runtime backend (instant A/B; flip back with agent_backend=runtime)
terraform apply -var="agent_backend=harness"

# Policy is ENFORCE by default; LOG_ONLY observes decisions without blocking
terraform apply -var="policy_enforcement_mode=LOG_ONLY"
```

### 7. Run the tests

```bash
# Backend (repo root). The suite imports the same backend modules the agent container runs,
# so it needs the runtime requirements as well as the test-only ones.
pip install -r agent-blueprint/recon-agent/requirements.txt -r requirements-dev.txt
export AWS_DEFAULT_REGION=us-east-1   # moto builds real boto3 clients; botocore needs a region
ruff check .
python -m pytest -q            # 1567 passed, 21 skipped, ~47s
#                              # 11 of the skips are in tests/integration/ — 10 need
#                              # RECON_GATEWAY_URL (+ dev-account creds), 1 also needs
#                              # EMAIL_CONFIRMATION_TOKEN. 4 are in tests/skills/, one
#                              # per skill that prescribes no required evidence steps,
#                              # and 6 in tests/input_corpus/, one per class that does
#                              # not configure both amount columns.

# Frontend (chatbot-app/frontend). `npm run build` is the gate that matters — it compiles
# every route, catching breakage both vitest and tsc miss.
cd chatbot-app/frontend && npm ci && npx tsc --noEmit && npx vitest run && npm run build
#                          # 79 files, 1069 passed
```

`npm run lint` is not part of this: ESLint is broken repo-wide. `npm run verify` points at a
`verify-build.sh` that does not exist. `ruff format --check` reports 34 files that predate the
convention, so formatting is not gated either. CI runs exactly the commands above.

These counts are a snapshot, not a gate — nothing asserts them, so treat a disagreement as this
line being stale rather than as a missing test, and re-measure before quoting it.

## CI/CD

Two pipeline samples — `.github/workflows/ci.yml` (verification only, no AWS credentials in any job)
and `.gitlab-ci.yml` (the same verification plus SAST, then `plan` + `apply` on `main`). The four
verification jobs, the GitLab-only SAST gate, and the three CI/CD variables the pipeline needs are in
**[assets/ci-cd.md](assets/ci-cd.md)**.

## Prerequisites & configuration

| Variable                                  | Required | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region`                                  | yes      | AWS region (default `us-east-1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `name_prefix`                             | yes      | Resource name prefix (e.g. `recon-dev`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `otel_layer_account`                      | **yes**  | AWS's own public publisher account for the `AWSOpenTelemetryDistroPython` layer. It declares no default on purpose: a wrong or absent value composes a valid-looking layer ARN that fails at apply with an opaque Lambda error, so Terraform stops and names the variable instead. Not a secret. It lives in tfvars only because the repo's pre-push guard rejects any 12-digit run in a committed file. Only read when `enable_worker_tracing = true`, though `terraform plan` requires it either way                                                        |
| `idp_state_machine_arn`                   | no       | ARN of the IDP document-processing Step Functions state machine. Recon's own EventBridge rule matches its terminal execution statuses, and that rule is the only thing that invokes the ingest hook — so an environment with an IDP deployment **must** set it. Empty creates no rule: uploads complete and the notices table stays empty with no error anywhere. Mutually exclusive with registering the hook on the IDP side (step 5)                                                                                                                       |
| `idp_input_bucket`                        | no       | Name of the IDP deployment's input bucket, from that stack's outputs. The Documents tab streams a document's source bytes from it, and an extraction-routed upload is put into it. Empty leaves the preview reporting it has nowhere to read from and the upload route nowhere to put a file — which is the correct behaviour, since the alternative is a put that lands where nothing reads it                                                                                                                                                               |
| `idp_input_bucket_arn`                    | no       | ARN of the same bucket. Only the console task role is granted on it, and only `s3:PutObject` on the object path — never `ListBucket`, and never on the pipeline's output prefixes                                                                                                                                                                                                                                                                                                                                                                             |
| `graph_enabled`                           | no       | Enable the `microsoft-graph` OpenAPI target (the platform's single email interface)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `graph_mailbox`                           | no       | Shared mailbox SMTP address all Graph email is sent from / read (must be a real mailbox in the Entra tenant)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `notify_email`                            | no       | Resolution-notification recipient (human approve + auto-resolve), sent **from** `graph_mailbox` via the gateway's `sendSharedMailboxMail` tool. Empty disables the email step. The dev environment points it at the shared mailbox itself, so notifications land in the same inbox the agent reads                                                                                                                                                                                                                                                            |
| `entra_tenant_id/client_id/client_secret` | no       | Entra app-only credentials for Graph email. `entra_tenant_id` + `entra_client_id` are **also** the intake API's JWT authorizer when `auth_provider=entra` (the default), and the plan fails without them                                                                                                                                                                                                                                                                                                                                                      |
| `auth_provider`                           | no       | Identity provider for BOTH the console login and the intake API's JWT authorizer: `okta` (deployed) or `entra` (var default). There is no Cognito fallback — one of the two must be fully configured or the plan fails                                                                                                                                                                                                                                                                                                                                        |
| `okta_issuer` / `okta_client_id`          | no       | Required when `auth_provider=okta`. They configure the console login **and** the intake API's authorizer — derived once in the root module's `oidc_*` locals so the API and the BFF accept identical tokens                                                                                                                                                                                                                                                                                                                                                   |
| `agent_backend`                           | no       | `runtime` (default) or `harness`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `harness_model_id`                        | no       | Override harness LLM (default `us.anthropic.claude-sonnet-5`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `policy_enforcement_mode`                 | no       | `ENFORCE` (default) or `LOG_ONLY` (observe only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `interceptor_mode`                        | no       | Gateway REQUEST interceptor: `enforce` (default) or `log` (observes only, **never blocks**). The example tfvars also ships `"enforce"` explicitly; set `"log"` only for a first rollout, then remove it.                                                                                                                                                                                                                                                                                                                                                      |
| `enable_worker_tracing`                   | no       | `true` (default) attaches the ADOT layer and OTel env to the agent-worker Lambda so its invocations share one trace with the agent's own spans. `false` means no layer, no OTel env, PassThrough X-Ray                                                                                                                                                                                                                                                                                                                                                        |
| `otel_layer_version`                      | no       | Version of AWS's public `AWSOpenTelemetryDistroPython` Lambda layer (default `30`; pinned rather than `latest`, which AWS does not publish)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reprocess_cap`                           | no       | Max re-process attempts before a case ages out (default `3`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `private_vpc`                             | no       | `false` (default) = public CloudFront + internet-facing ALB. `true` = the whole private topology in one flag: internal ALB on private subnets, Fargate with no public IP, no CloudFront, the interface endpoints, plus a VPC-only PRIVATE REST API onto the intake Lambda (an HTTP API cannot be made private, so `POST /items` would otherwise stay internet-facing). Does **not** remove the NAT — see [Private VPC deployment](assets/private-vpc-deployment.md) and [the intake API](assets/intake-http-api.md#reaching-it-from-a-private-vpc-deployment) |
| `private_ingress_cidrs`                   | no       | CIDRs allowed to reach the internal ALB when `private_vpc=true` (VPN/corporate ranges). Empty ⇒ the VPC CIDR only. Ignored when `private_vpc=false`                                                                                                                                                                                                                                                                                                                                                                                                           |

Copy `infra/environments/recon/terraform.tfvars.example` → `terraform.tfvars` and fill values.
`terraform.tfvars.example` is the only committed record of which variables an environment is
expected to set — add a placeholder entry there (never a real credential) in the same change that
adds a variable.

---

## Case lifecycle

![Case lifecycle](assets/case-lifecycle.svg)

An item is ingested as `PENDING`, deterministically cleared to `AUTO_CLEARED` or escalated to
`IN_PROGRESS`, and then either `PROPOSED` for an analyst or executed autonomously straight to
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

The runtime is reached through the ingress agent gateway (SigV4, with a direct
`InvokeAgentRuntime` fallback).

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
  fronting the Runtime: one controlled SigV4 entry point for the Tier-1 worker and the BFF.

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

`NEXT_PUBLIC_AUTH_PROVIDER` (build-time, from the `auth_provider` Terraform var) selects one of two
providers:

- `okta` is the Okta OIDC redirect flow (`@okta/okta-auth-js`), and needs `okta_issuer` plus
  `okta_client_id`. This is what the dev environment is deployed with.
- `entra` is Microsoft Entra ID via MSAL. It is the Terraform variable's default, so it applies when
  `auth_provider` is unset.

`UserMenu` shows the signed-in user's name and a Logout button. The intake HTTP API's JWT authorizer
validates this **same** provider — issuer and audience are derived from `auth_provider` once, in the
root module's `oidc_*` locals — so the API and the BFF accept identical tokens. There is no Cognito
user pool in this deployment. That authorizer, the two routes behind it, the VPC-only SigV4 door and
the `POST /items` contract are in **[assets/intake-http-api.md](assets/intake-http-api.md)**.

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

### Estimated monthly cost (demo profile, us-east-1)

| Service                                                                 | Driver                                                       | Est. $/mo     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| **Amazon Bedrock — Claude Sonnet**                                      | ~300 investigations + eval judges (~20M in / ~1M out tokens) | **~$70**      |
| **NAT Gateway**                                                         | 1 gateway (~$0.045/hr) + data processing                     | **~$35**      |
| **CloudWatch** (logs, metrics, Transaction Search spans, Logs Insights) | OTel spans + eval queries                                    | **~$25**      |
| **AgentCore** (Runtime/Harness, Gateway, Memory, Evaluations)           | low invocation volume; consumption-priced                    | **~$20**      |
| **ECS Fargate** (frontend)                                              | 1 task, 0.5 vCPU + 1 GB, 24×7                                | **~$18**      |
| **Application Load Balancer**                                           | 1 ALB, low LCU                                               | **~$18**      |
| **WAF** (CloudFront web ACL)                                            | 1 web ACL + 1 managed rule group + low request volume        | **~$6**       |
| **Secrets Manager / SSM / ECR / CodeBuild**                             | few secrets, params, image builds                            | **~$5**       |
| **Bedrock — Knowledge Base ingestion + `Retrieve`**                     | seed corpus + retrievals (managed KB owns the embedding)     | **~$3**       |
| **Lambda** (idp-hook, tier1, worker, gl, interceptor, evaluator, etc.)  | demo invocations, mostly free-tier-adjacent                  | **~$3**       |
| **DynamoDB** (items, cases, audit, lessons — on-demand)                 | low RCU/WCU                                                  | **~$3**       |
| **S3** (assets, skills, configs, GL, IDP page copies)                   | few GB + requests                                            | **~$2**       |
| **CloudFront**                                                          | low egress                                                   | **~$2**       |
| **Athena** (GL queries via `search_ledger`)                             | small scans, $5/TB                                           | **~$1**       |
| **Total (demo profile)**                                                |                                                              | **≈ $211/mo** |

_These are rough list-price estimates for planning only. Validate them against the AWS Pricing
Calculator and your actual traffic before relying on them._

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## Authors

- Felix Huthmacher, Senior Applied AI Architect [github - fhuthmacher](https://github.com/fhuthmacher)

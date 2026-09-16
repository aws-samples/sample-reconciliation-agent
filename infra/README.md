# `infra/` — Terraform

All infrastructure. There is no CDK in this repo.

```
environments/recon/          the ONE root: the recon platform, the console and — behind
                             enable_deal_pipeline — the deal-pipeline app beside it; CI plans
                             and applies it
modules/                     one module per component, composed by the root
bootstrap/                   the state bucket, applied once before anything else
scripts/                     operational tooling (deploy driver, seed push, resets)
```

## Where to run terraform

**`infra/environments/recon/` is the root module, and the only one.** Running `terraform validate`
from `infra/` passes _vacuously_ — there is no configuration at that level, so it validates nothing:

```bash
cd infra/environments/recon
terraform init -backend=false      # no credentials needed
terraform validate
terraform fmt -check -recursive ../..
```

The deal-pipeline app has no root of its own: `modules/deal-pipeline` is composed into this root
behind `enable_deal_pipeline`, under the `<name_prefix>-pipeline` prefix, and the console container
serves both apps behind one app rail. (A standalone root under `environments/deal-pipeline` existed
while the app was being built; it was dropped so there is one deployment to reason about, and
laptop development renders its `.env.local` from this root instead — next section.)

## Running the console on a laptop against a deployment

`npm run dev` needs every table, bucket, parameter and function name the deployed console has. The
root renders them:

```bash
cd infra/environments/recon
terraform output -raw frontend_env_local > ../../../chatbot-app/frontend/.env.local
cd ../../../chatbot-app/frontend && npm run dev     # the BFF runs with your AWS credentials
```

Every value is read back from the console's ECS task definition (`module.frontend.task_environment`),
not re-derived, so the laptop and the container agree on what each name means. The only lines that
are not the task's are the local-development settings `.env.example` documents:
`ALLOW_ANONYMOUS_API=true`, `SAMPLE_EMAILS_DIR`, `NEXT_PUBLIC_AUTH_PROVIDER` and
`CONSOLE_DEFAULT_MODEL_ID`. The pipeline block is rendered only when `enable_deal_pipeline = true`;
with it false the file carries `PIPELINE_ENABLED=false`, as the container does. The output is
sensitive (it carries `EMAIL_CONFIRMATION_TOKEN`); `-raw` prints it regardless, and `.env.local` is
gitignored. Re-render after an apply rather than editing by hand.

## Module tests

Modules carry `terraform test` suites under `tests/`, all under mocked providers (no credentials,
nothing created; plan-only apart from `seeded-object`'s applies against the mock, which exist so a
second plan can show `ignore_changes` at work). CI discovers them — every `infra/modules/*/tests`
directory — so adding a suite to a module needs no CI edit:

```bash
for tests in infra/modules/*/tests; do
  (cd "$(dirname "$tests")" && terraform init -backend=false && terraform test)
done
```

- **`console-settings/`** — every console-wide setting lands at exactly the key the frontend reads
  under the prefix, a blank seed creates no parameter (never a placeholder the console would read as
  stored), seeds are trimmed and obey the Settings screen's own limits, and a prefix without a
  leading slash or with a trailing one fails at plan.
- **`agentcore-memory/`** — the extraction strategy exists if and only if one is configured and
  carries the caller's name, namespaces, model and prompt verbatim under CUSTOM / SEMANTIC_OVERRIDE
  with an extraction block only; the execution role's policy grants exactly `InvokeModel` and
  `InvokeModelWithResponseStream` on every foundation model and the caller's inference profiles, and
  renders byte for byte the JSON `recon-agent` rendered inline before the memory moved into the
  module; the role is declared on the memory as well as the strategy; a memory handed another
  memory's role creates none; description and tags stay unset unless given.
- **`deal-pipeline/`** — each Lambda's role grants exactly what its handler calls, and every S3
  location a Lambda is given is one its role can read; the sample corpus seeds under the prefix the
  module outputs; skills and the parser prompt are create-only seeds and are exactly the keys the
  `editable_seeds` output hands the root's seed push, while the assistant prompt, security master and
  corpus track the repo. And the console wiring the module exports for `frontend-ecs`'s `app_wiring`
  input (`console_environment`, `console_task_statements`): exactly the documented BFF variables,
  with this module's values, and verb-per-resource grants that match what the BFF calls -- pinned by
  hash to what `frontend-ecs` rendered before the wiring moved here, so the move changed nothing.
- **`deploy-actions/`** — the actor role's policy with no additional seed bucket renders byte for
  byte the six statements it always had (a deployed environment plans no change), and each
  additional bucket appends exactly its two seed-reconciliation statements after them.
- **`frontend-ecs/`** — the per-app wiring, with synthetic apps: a recon-only console (`app_wiring`
  empty, or no enabled entry) renders a task policy and a container environment that hash to the
  rendering from before the input existed, byte for byte; enabled apps' variables and statements are
  appended after every recon variable and statement, in app order and then exactly as exported --
  never re-sorted, because the order is part of the task definition and a reorder would roll every
  console with an app enabled; a disabled app contributes nothing; a variable name exported twice, or one that reuses a recon name, fails at
  plan; `pipeline_enabled` with a blank access group fails at plan. Also the console-settings wiring:
  the three `CONSOLE_*` variables are in the task environment whether or not a second app is
  deployed, the task role's SSM grant names exactly `parameter<prefix>` and `parameter<prefix>/*`
  with a literal region and account (`DeleteParameter` is in it), and a blank prefix grants nothing.
  And that the `task_environment` output is exactly the container's environment, which is what the
  root's `frontend_env_local` renders.
- **`lambda-package/`** — what changes the staging hash (every staged file, renames, the instance
  name) and what does not (bytecode caches, virtualenvs, OS and tool droppings such as `.DS_Store`),
  and that each module instance stages into its own directory.
- **`seeded-object/`** — exactly one of its two `aws_s3_object` blocks is instantiated; bucket, key,
  source, etag and content type pass through unchanged; and, applied against the mock and planned
  again, a create-only seed keeps its live etag, source and content type when the repo file or the
  content type changes, while a tracking seed plans the re-upload.

## Per-app access

The console serves two apps behind an app rail, and the BFF proxy checks the caller's IdP group
claim against the app a route belongs to. Three root variables carry the groups —
`recon_access_group`, `pipeline_access_group`, `pipeline_admin_group` — beside the existing
`recon_admin_group`. Admin groups left empty mean **nobody** administers the app. Access groups left
empty leave the app **open** to every authenticated user only in a recon-only deployment (what every
deployment had before the rail); with `enable_deal_pipeline = true` both access groups are
**required** — the plan refuses a blank one, and the console runs with `REQUIRE_ACCESS_GROUPS=true`
so a blank group fails closed at runtime too — because two populations then sign in through one
OIDC client and several recon write routes are gated by the access check alone. Admins have access
implicitly.

**Console-wide settings.** The same groups are also seeded into SSM under `/<name_prefix>/console`
by `modules/console-settings` (contract: `chatbot-app/frontend/src/lib/console/types.ts`), where
members of `console_admin_group` change them from the console's Settings screen without a redeploy.
A stored value outranks the environment (stored -> env -> default); Terraform ignores value changes
after creation, so an apply never reverts one; a blank seed creates no parameter, and the UI creates
it on first save. `console_admin_group` itself is environment-only and fails closed when blank, as
are `REQUIRE_ACCESS_GROUPS` and the anonymous switches -- a UI edit cannot widen access past what the
deployment allows or make someone a console admin. The task role's grant is scoped to the prefix by
`modules/frontend-ecs`.

## ⚠️ CI owns the apply

A merge to `main` runs `terraform apply -auto-approve`. Two consequences:

1. **A local apply races the pipeline.** Don't, except for a cold apply into a fresh account, which
   `.gitlab-ci.yml` documents as exceeding the credential-vendor time ceiling and therefore
   local-only (`./scripts/deploy-recon.sh apply`).
2. **CI does not read your working-copy `terraform.tfvars`.** It reconstructs it from the protected
   `RECON_TFVARS` CI variable. Editing the local file alone changes nothing about the deployment, and
   the next pipeline will revert whatever a local apply did. Change both, or only the CI variable.

### The destroy guard

The plain `terraform:apply` job **fails** when the plan contains deletions, and
`terraform:apply:allow-destroy` is the deliberate manual escape hatch. It matches
`actions == ["delete"]` exactly, so a _replacement_ (delete + create) passes through — which is why
renaming an S3 seed object needs the manual job while replacing a runtime does not.

The guard's warning names the failure it exists for: a truncated `RECON_TFVARS` makes `graph_enabled`
default to `false`, and the Graph gateway target, OAuth provider and callback SSM parameter get
planned for destruction. **Check that variable before approving anything.**

The same job also refuses a planned **replacement** of an `aws_bedrockagentcore_memory`,
`aws_bedrockagentcore_memory_strategy` or `aws_s3_object`. Those are the resources whose contents
Terraform cannot put back -- a memory's consolidated records (the recon lessons), a create-only seed's
live edit -- and nothing in an ordinary apply replaces them: a replace there means a `moved` block
that missed or a changed name, key or bucket (see the plan checklist under Seeds). `terraform:plan`
prints a NOTE for both cases one stage earlier; `terraform:apply:allow-destroy` is the override for
both.

## Module notes worth knowing before you edit

- **`recon-agent/`** — the Gateway, its targets, the Cedar policy and the managed knowledge base.
  Retiring a gateway target takes **two applies**: the `depends_on` edge that would order the policy
  update is deleted along with the target, so a single apply can update the policy first and leave
  `recon_reads` in `UPDATE_FAILED`, which costs the agent every read tool because Cedar fails closed.
- **`frontend-ecs/`** — image hash covers `src/**`, `public/**`, root config files and the
  `NEXT_PUBLIC_*` build args. A config change that does not move the hash would otherwise keep
  serving the old image forever, because the CodeBuild trigger skips when the tag already exists.
- **`microsoft-graph-obo/`** — depends on `recon-agent` for `gateway_id`, so it can never be
  referenced back from there. That is why the gateway's grant on its OAuth secret is matched by
  secret _name_ rather than ARN: an ARN reference would close a module cycle.
- **`observability/`** — delivers runtime traces into `aws/spans`, which is what lets the online
  evaluation config score runtime-backend sessions at all.
- **`tier2-dispatch/`** — the only Step Functions in the repo, and the thing that bounds Bedrock token
  spend for the **runtime** backend via the Distributed Map's `MaxConcurrency`. Four things to know
  before editing it:
  - **The schedule ships `DISABLED` in the module, and recon-dev has opted in** at `rate(5 minutes)`.
    Enabling it starts firing agent runs, and therefore Bedrock spend, unattended, so a new
    environment opts in deliberately. That interval is also the latency an escalated case waits
    before its investigation begins.
  - **`terraform validate` does not check the ASL.** An invalid definition applies cleanly and fails
    at runtime. Validate the rendered definition with
    `aws stepfunctions validate-state-machine-definition` before merging.
  - **The states role needs `states:StartExecution` on itself.** A Distributed Map runs each iteration
    as a child execution of the same state machine, and the failure without it names `StartExecution`
    rather than the Map.
  - **`MaxConcurrency` here and `max_concurrent_investigations` on `tier1/` are the same quota** in two
    mechanisms — the map bounds the runtime backend, the worker's reserved concurrency bounds the
    harness backend. Change one and change the other.
- **`agentcore-memory/`** — one AgentCore Memory, its execution role and policy, and an optional
  CUSTOM / SEMANTIC_OVERRIDE extraction strategy; `recon-agent` uses it for the lessons memory,
  `deal-pipeline` for its knowledge memory (with a strategy) and chat memory (without, sharing the
  role). Two lessons are encoded once there: the role must be declared on the memory as well as the
  strategy or every plan wants to null it (permanent drift), and `append_to_prompt` REPLACES the
  built-in extraction instructions despite its name. The provider-deprecated `namespaces` and
  strategy-level role arguments are kept on purpose: migrating either is an in-place update of a live
  strategy. A memory's `name` and a strategy's `name` are create-only; renaming replaces, and loses
  every stored record.
- **`seeded-object/`** — see Seeds below. Its `key` is create-only too: renaming a seed replaces the
  object and discards the application's edits to it.
- **`console-settings/`** — Terraform manages the parameters' _existence_, the UI their _values_.
  Three consequences: a UI "clear" (a delete -- SSM has no empty value) is re-seeded by the next
  apply unless the tfvars seed is blanked too; a seed given a value _after_ the UI created that
  parameter fails with `ParameterAlreadyExists` (import it rather than let Terraform overwrite the
  operator's value); and blanking a seed plans a **delete** of that parameter, which the destroy
  guard above refuses in the plain apply job.

## Seeds

Every S3 object seeded from the repo is an instance of `modules/seeded-object`, in one of two modes.

**Create-only** (`create_only = true`) is for objects the application rewrites in place: recon's
`system-prompt.md`, `system-prompt-harness.md` and `skills/<name>/SKILL.md`; the pipeline's
`skills/<name>/SKILL.md` and `prompts/parser-system.md`. Terraform writes them once and then ignores
`etag, source, content, content_type, metadata, cache_control, content_encoding, storage_class` --
the wide list, spelled once in that module, because the provider answers drift in _any_ of them by
re-uploading the repo file over the analyst's edit (recon's inline seeds ignored only `etag, source`
until 2026-09; an application write that merely set a charset could have reverted a skill).
**Tracking** (`create_only = false`) is for content with no UI editor -- the pipeline's assistant
prompt, security master and sample corpus: a committed change re-uploads on the next apply.

Repo edits to create-only seeds still reach S3, and **not by `terraform taint`**: a tainted seed is
re-created from the repo, which is exactly the revert the lifecycle rule prevents. Instead
`aws_lambda_invocation.seed_push` (recon's bucket) and `aws_lambda_invocation.pipeline_seed_push`
(the pipeline's, once `enable_deal_pipeline` and `enable_pipeline_seed_push` are both set -- the
plan checklist below says why the second switch exists) run the deploy-actions `push_editable_seeds`
action on every apply. Per key it compares the repo MD5, the live ETag and the `.seed-marker/<key>.md5` it last
wrote, and takes one of four outcomes: no-op, adopt, push, or fail. A live edit alone wins silently; a
repo edit alone is pushed; both sides changed fails the apply, naming every such key with the two
commands that resolve it. The pipeline module's `editable_seeds` output is the key => file map its
push reads, derived from the same locals as its seed modules, so what is seeded and what is pushed
cannot disagree. Both buckets are SSE-S3, which the action checks before comparing anything: only
there is an object's ETag its MD5. `scripts/push_editable_seeds.py` runs the same rules by hand and
`tests/infra/` covers every branch.

### Plan checklist after the module moves (2026-09)

`modules/agentcore-memory` and `modules/seeded-object` replaced resources that were declared inline,
each with a `moved` block and every argument passed with the value it had. The first `terraform plan`
on the recon root after this change must show these, and only these, as `# ... has moved to ...`:

- `module.recon_agent.aws_bedrockagentcore_memory.this` → `module.recon_agent.module.memory.aws_bedrockagentcore_memory.this`
- `module.recon_agent.aws_iam_role.memory` → `module.recon_agent.module.memory.aws_iam_role.memory[0]`
- `module.recon_agent.aws_iam_role_policy.memory` → `module.recon_agent.module.memory.aws_iam_role_policy.memory[0]`
- `module.recon_agent.aws_bedrockagentcore_memory_strategy.lessons` → `module.recon_agent.module.memory.aws_bedrockagentcore_memory_strategy.this[0]`
- `aws_s3_object.system_prompt_seed` → `module.system_prompt_seed.aws_s3_object.create_only[0]`
- `aws_s3_object.harness_system_prompt_seed` → `module.harness_system_prompt_seed.aws_s3_object.create_only[0]`
- `aws_s3_object.skill_seed["<file>.md"]` → `module.skill_seed["<file>.md"].aws_s3_object.create_only[0]`, one per skill file (seven today)

and **no create, destroy or replace** of any of them, and no `~ update in-place` on the memory, its
role or policy, the strategy, or any seed object. For a recon-only deployment the summary line is
`Plan: 0 to add, 0 to change, 0 to destroy` (moves are not counted). Do not apply a plan that departs
from this; read it first:

- an in-place update of the strategy's `append_to_prompt` means the heredoc's indentation or
  trailing newline changed -- fix `modules/recon-agent/main.tf`, do not apply;
- a destroy plus create of a seed object means a `moved` key is wrong (the object would be re-created
  from the repo over the analyst's edit) -- the CI guard refuses the destroy;
- a replace of the memory or the strategy means a name changed -- every stored lesson would be lost;
  the CI guard refuses it.

With `enable_deal_pipeline = true` the plan additionally shows the pipeline module's own moves (its
two memories, role, policy and strategy; its skill, prompt, security-master and sample seeds) and an
in-place update of `module.deploy_actions.aws_iam_role_policy.actions` appending the two statements
for the pipeline bucket. It shows **no change to `module.frontend.aws_ecs_task_definition.frontend`
or `module.frontend.aws_iam_role_policy.ecs_task`**: the pipeline's variables and statements now
reach the console through `app_wiring`, appended in the order the pipeline module exports them,
which is the order the console rendered when it built them from its own `pipeline_*` inputs
(`modules/deal-pipeline/tests/console_wiring.tftest.hcl` pins both lists byte for byte against that
rendering; `modules/frontend-ecs/tests/app_wiring.tftest.hcl` pins that the console appends an app's
list exactly as exported, never re-sorted). A new task-definition revision in that plan means a
name, value or position changed and the console would roll -- read it before applying.

`aws_lambda_invocation.pipeline_seed_push[0]` appears only once `enable_pipeline_seed_push = true`,
and that variable is off by default on purpose: the reconciliation's first run against a pipeline
whose skill or prompt objects were edited live before the push existed (an approved skill proposal,
a Skills-tab prompt edit) fails the apply as AMBIGUOUS -- no marker yet, live ETag differs from the
repo MD5 -- after the moves and the policy update in the same apply have already landed, which is not
where an auto-applying CI should stop. Adopt those keys first, by hand, from the repo root with the
deployer's credentials:

    eval "$(cd infra/environments/recon && terraform output -raw pipeline_seed_push_command)"

That runs `infra/scripts/push_editable_seeds.py` against the pipeline bucket with exactly the keys
the module seeds (the command is rendered from its `editable_seeds` output). A key in sync with the
repo is `adopted`; each AMBIGUOUS key is named with its two commands (take repo, or keep live and
commit it); repeat until it exits 0. Then set `enable_pipeline_seed_push = true`: the push it adds
finds every key adopted and reports `noop`, and from there it runs on every apply as recon's does.
Watch that apply, as every 11b change asks. A fresh deployment can set the variable true from the
start -- a just-created object is the `record` branch and cannot be ambiguous.

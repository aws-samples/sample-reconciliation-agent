# `infra/environments/deal-pipeline/` — the deal-pipeline demo root

Terraform root for the deal-pipeline demo described in `docs/deal-pipeline-design.md`. It creates
one S3 bucket, three DynamoDB tables, two AgentCore Memories, the pipeline's model parameter and two
Lambdas, using `infra/modules/deal-pipeline` and the shared `infra/modules/lambda-package`, plus the
console-wide settings parameters from `infra/modules/console-settings` (see
[Console-wide settings](#console-wide-settings)).

State is **local** (no `backend` block): this is a single-developer demo that is applied and torn
down from one machine. Everything carries `Project = deal-pipeline-demo` and `ManagedBy = terraform`
through the provider's `default_tags`, so a tag search finds every resource this root made — the
cleanup story if a destroy is ever interrupted.

## Two ways to run the pipeline

This root is the **local-development** shape: the pipeline's AWS resources under the
`deal-pipeline-dev` prefix, and the Next.js BFF on your laptop with your credentials. The
**deployed** shape is the recon root: `infra/environments/recon` composes the same
`modules/deal-pipeline` behind `enable_deal_pipeline = true`, under the `<name_prefix>-pipeline`
prefix (so the two never collide in one account), and the recon console's ECS task serves both apps
behind an app rail. Per-app access there is `recon_access_group` / `pipeline_access_group` /
`pipeline_admin_group` in the recon root's tfvars; with `enable_deal_pipeline = true` both access
groups are **required** (the plan refuses a blank one) and the task runs with
`REQUIRE_ACCESS_GROUPS=true`, so a blank group fails closed rather than open. A recon-only console
gets `PIPELINE_ENABLED=false`, which hides the pipeline app and 403s its API.

The frontend is one process serving two apps, which is why three of the variables below carry a
`PIPELINE_` prefix: the recon app already reads `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` and
`SKILLS_PREFIX` for *its* bucket, parameter and prefix. The pipeline BFF reads
`PIPELINE_ASSETS_BUCKET`, `PIPELINE_AGENT_MODEL_PARAM` and `PIPELINE_SKILLS_PREFIX` **only** -- there
is no fallback to the bare names, because in the composed console a fallback silently pointed the
pipeline's Skills and Config tabs at recon's bucket and model parameter. Re-render `.env.local` from
`env_local` if yours predates the prefix.

## Deploy

```bash
cd infra/environments/deal-pipeline
cp terraform.tfvars.example terraform.tfvars   # optional: every variable has a default
terraform init
terraform plan -out=dp.tfplan
terraform apply dp.tfplan
```

Requires Terraform >= 1.11, AWS credentials for the target account, `rsync`, and `python3` (the
packaging script is shared by every root that uses the module; with an empty dependency list it never calls pip).

`plan` warns — without failing — if the seed content is not in the tree yet:
`agent-blueprint/deal-pipeline-agent/skills/*/SKILL.md`, `.../prompts/parser-system.md`,
`.../prompts/assistant-system.md`, `data/deal-emails/*.json`. A plan that shows those warnings will
deploy a parser with no skills and no system prompt, or an inbox with nothing to simulate; add the
files and apply again.

## Wire the frontend

Every value the BFF needs is an output; `env_local` renders the whole file:

```bash
terraform output -raw env_local > ../../../chatbot-app/frontend/.env.local
cd ../../../chatbot-app/frontend && npm run dev
```

What the rendered file says about access, and why:

- `ALLOW_ANONYMOUS_API=true` — local-dev mode, one switch for both apps (there is one server
  process, so two switches could never have left one app open and the other verified). It replaces
  the older `PIPELINE_ALLOW_ANONYMOUS_API`, which the BFF still honours. Anonymous mode grants every
  configured app group, so the shell shows both apps as an admin.
- `PIPELINE_ADMIN_GROUP=deal-desk-admins` — the group the write routes check once an IdP is wired
  up. Fails closed when empty.
- `PIPELINE_ACCESS_GROUP=` — empty on purpose: **open** to every authenticated user, which is what
  the app had before the rail existed. Admins have access implicitly. Name a group to restrict.
- `# RECON_ACCESS_GROUP=` / `# RECON_ADMIN_GROUP=` — commented out, not omitted: the recon stack is
  a separate root and this one does not deploy it. Left unset, the recon app is open in the shell
  but has no backing resources locally.
- `# ANONYMOUS_GROUPS=deal-desk` — uncomment to preview the shell as a restricted user (a pipeline
  user who is not an admin); name a group no app uses to preview a caller in no groups.
- `SAMPLE_EMAILS_DIR=../../data/deal-emails` — local dev reads the simulate dialog's corpus from
  disk, so an edited sample shows up without an apply. The module ALSO seeds the corpus to S3 under
  `samples/` (output `samples_prefix`), which is what the deployed console reads; set
  `PIPELINE_SAMPLES_PREFIX=samples/` to exercise that path locally.

## Console-wide settings

The console has a configuration layer **above** the two apps: who may reach which app, whether the
opt-in app is deployed, and defaults an app may inherit. Per-app configuration (the pipeline's model,
recon's thresholds) is not part of it and stays in each app's Config tab. The layer is stored in SSM
Parameter Store, one `String` parameter per setting under `CONSOLE_SETTINGS_PREFIX`, which this root
sets to `/<name_prefix>/console` (`/deal-pipeline-dev/console` by default) through
`infra/modules/console-settings`. The keys are fixed by the frontend contract
(`chatbot-app/frontend/src/lib/console/types.ts`):

| Parameter                                    | Seeded from                                        | Created by this root                         |
| -------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `<prefix>/access/recon/access-group`         | blank -- the recon stack is another root's         | no: the UI creates it on first save          |
| `<prefix>/access/recon/admin-group`          | blank                                              | no                                           |
| `<prefix>/access/pipeline/access-group`      | blank (`PIPELINE_ACCESS_GROUP=` in `env_local`: open) | no                                        |
| `<prefix>/access/pipeline/admin-group`       | `deal-desk-admins`, the `env_local` value          | yes                                          |
| `<prefix>/apps/pipeline/enabled`             | `"true"`                                           | yes                                          |
| `<prefix>/defaults/model-id`                 | `agent_model_id`                                   | yes                                          |
| `<prefix>/defaults/organization-label`       | `console_organization_label`                       | yes                                          |

Also under the prefix, and never created by Terraform: `<prefix>/prefs/<hash>`, one JSON document
per user with their rail state, theme and default app. The frontend writes those. `terraform output
console_settings_parameters` lists exactly what an apply creates.

**Precedence.** For every setting the console resolves _stored (non-blank) -> environment ->
default_. The stored layer overlays the same variable names `.env.local` carries
(`PIPELINE_ADMIN_GROUP`, `PIPELINE_ENABLED`, ...), so on the day of the first apply the two agree; once
an operator edits in the Settings screen the stored value wins and `.env.local` becomes the fallback.
Three switches are environment-only and can never be changed from the UI: `REQUIRE_ACCESS_GROUPS`,
`ALLOW_ANONYMOUS_API` (and its legacy names) and `CONSOLE_ADMIN_GROUP` itself. Comment
`CONSOLE_SETTINGS_PREFIX` out of `.env.local` and the layer is off: everything resolves from the
environment, the Settings screens render read-only, and preferences fall back to the browser.

**The UI owns the values; Terraform owns only their existence.** Every parameter carries
`ignore_changes` on its value: Terraform seeds it once and no later apply reverts what an operator
saved. Changing `agent_model_id` or `console_organization_label` in tfvars after the first apply
therefore changes `.env.local` (the fallback) and nothing stored -- change a stored value in the
Settings screen. Two corollaries of "existence, not value":

- A blank seed creates **no** parameter (SSM refuses an empty value, and any placeholder would read
  as a stored value that outranks the environment). The UI creates it on first save. Giving that seed
  a value in tfvars _afterwards_ fails at apply with `ParameterAlreadyExists` rather than overwriting
  the UI's value: `terraform import 'module.console_settings.aws_ssm_parameter.setting["access/pipeline/access-group"]' /deal-pipeline-dev/console/access/pipeline/access-group`,
  or leave the seed blank -- the stored value stands either way.
- Clearing a value in the UI **deletes** the parameter. The next apply re-creates it from the seed
  unless the seed is blank too, so clearing for good is a two-step: clear in the UI, blank the seed.

**Who may edit.** `CONSOLE_ADMIN_GROUP` (`console-admins` here, from `console_admin_group`). In
anonymous mode you are a console admin regardless, so the Settings screen is editable out of the
box; `ANONYMOUS_GROUPS=deal-desk` previews a user who is not. This root creates no IAM for the layer:
the BFF runs with your credentials. The deployed console's task role gets a grant scoped to its own
prefix from `infra/modules/frontend-ecs`.

## Destroy

```bash
terraform destroy
```

Removes the console-wide parameters Terraform seeded and leaves the UI-created ones behind (any
blank-seeded setting saved from the UI, every `prefs/` document) -- they carry no `Project` tag
either, since Terraform never saw them. `aws ssm get-parameters-by-path --path
/deal-pipeline-dev/console --recursive --query 'Parameters[].Name'` lists what is left to delete.

The bucket has `force_destroy = true`, so emails, staging CSVs and OMS-staging copies go with it.
The DynamoDB tables have no deletion protection and no point-in-time recovery — they hold synthetic
demo data only.

## Things to know before you edit

- **Skill and parser-prompt seeds are create-only.** `skills/*/SKILL.md` and
  `prompts/parser-system.md` are uploaded once and then carry `ignore_changes` on `etag`, `source`,
  `content_type`, `metadata`, `cache_control`, `content_encoding` and `storage_class`, because the
  application rewrites them: an approved skill proposal writes S3, and the Skills tab edits the
  prompt. Tracking the repo file would make any later apply undo what the demo taught. The list is
  wider than `etag`/`source` because the AWS provider treats a change to any of those attributes as
  a content change and re-uploads the object from the repo file. So the BFF may write these
  objects with any content type, metadata, cache-control, encoding or storage class; if it ever
  needs to set an attribute *not* in that list (tags, SSE settings, content-disposition...), add
  it to both seeds' `ignore_changes` in `infra/modules/deal-pipeline/main.tf` first, or the next
  apply reverts the learned content. To force-reseed, `terraform taint` the object (or delete it in S3 and apply).
  The assistant prompt, the security-master CSVs and the `samples/` corpus have no UI editor and
  *do* track the repo: editing `data/deal-emails/*.json` re-uploads on the next apply.
- **The Config tab owns the model parameter.** `/deal-pipeline-dev/agent-model-id` is seeded from
  `agent_model_id` and then ignored; change the model in the UI, not in tfvars. The console-wide
  parameters under `/deal-pipeline-dev/console` follow the same rule, with the blank-seed and
  re-seed corollaries in [Console-wide settings](#console-wide-settings).
- **Per-root staging directory.** `lambda-package` stages into `.build/<name>/staging` under its own
  module path, keyed by the `name` each root passes (`deal-pipeline-backend` here, the default
  `backend` in the recon root), so the two roots keep separate staging trees and separate zips in
  one checkout. Nothing re-stages when you switch roots; each root's `terraform_data.stage` keys on
  its own sources, dependency list and name. The directories used to be one, and a recon plan that
  followed an apply here zipped this root's tzdata-only tree for every recon Lambda with no replace
  in the plan to show for it. Two roots given the *same* `name` would still collide.
- **The whole `backend/` tree is packaged**, not just `backend/deal_pipeline`. In a checkout that also
  holds the recon backend, the zip is larger than the two handlers need; it is one shared packager
  and the cost is a few megabytes, not a behaviour difference.
- **Any file under `backend/` redeploys both Lambdas.** The zip is rebuilt when the path or
  content of any staged file changes — `oms_fields.json`, `pyproject.toml` and `README.md`
  included, not just `*.py` — because both handlers load the OMS schema from that JSON at import.
  `terraform plan` shows the change as a replace of `module.lambda_package.terraform_data.stage`
  and both functions' `source_code_hash` as known-after-apply.
- **If `plan` fails with "could not archive missing directory".** The gitignored
  `infra/modules/lambda-package/.build/deal-pipeline-backend/staging` is gone (for example after
  `git clean -fdx`) while the state still records the staging as current. Rebuild it with
  `terraform apply -replace=module.lambda_package.terraform_data.stage`, or run
  `infra/modules/lambda-package/stage.sh` by hand with the arguments its header lists.
- **Parser async retries are 0.** The BFF invokes the parser with `InvocationType=Event`; the
  default two retries would re-run the model behind the operator's back and could stage a second
  deal for the same email. Reparse is the intended retry.

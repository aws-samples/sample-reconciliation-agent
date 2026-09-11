# `infra/environments/deal-pipeline/` — the deal-pipeline demo root

Terraform root for the deal-pipeline demo described in `docs/deal-pipeline-design.md`. It creates
one S3 bucket, three DynamoDB tables, two AgentCore Memories, one SSM parameter and two Lambdas,
using `infra/modules/deal-pipeline` and the shared `infra/modules/lambda-package`.

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
`pipeline_admin_group` in the recon root's tfvars.

The frontend is one process serving two apps, which is why three of the variables below carry a
`PIPELINE_` prefix: the recon app already reads `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` and
`SKILLS_PREFIX` for *its* bucket, parameter and prefix. The pipeline BFF reads
`PIPELINE_ASSETS_BUCKET`, `PIPELINE_AGENT_MODEL_PARAM` and `PIPELINE_SKILLS_PREFIX` first and falls
back to the bare names, so an older `.env.local` keeps working.

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

## Destroy

```bash
terraform destroy
```

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
  `agent_model_id` and then ignored; change the model in the UI, not in tfvars.
- **Shared staging directory.** `lambda-package` stages into a directory under its own module path,
  shared by every root that uses the module. Plan/apply one root at a time from a single checkout.
  The recon root passes a longer `runtime_dependencies` list (its zip also feeds the recon Lambdas),
  so switching between the two roots re-stages: expect `terraform_data.stage` to replace and both
  functions' `source_code_hash` to read known-after-apply on the first plan after the other root ran.
- **The whole `backend/` tree is packaged**, not just `backend/deal_pipeline`. In a checkout that also
  holds the recon backend, the zip is larger than the two handlers need; it is one shared packager
  and the cost is a few megabytes, not a behaviour difference.
- **Any file under `backend/` redeploys both Lambdas.** The zip is rebuilt when the path or
  content of any staged file changes — `oms_fields.json`, `pyproject.toml` and `README.md`
  included, not just `*.py` — because both handlers load the OMS schema from that JSON at import.
  `terraform plan` shows the change as a replace of `module.lambda_package.terraform_data.stage`
  and both functions' `source_code_hash` as known-after-apply.
- **If `plan` fails with "could not archive missing directory".** The gitignored
  `infra/modules/lambda-package/.build/` is gone (for example after `git clean -fdx`) while the
  state still records the staging as current. Rebuild it with
  `terraform apply -replace=module.lambda_package.terraform_data.stage`, or run
  `infra/modules/lambda-package/stage.sh` by hand with the arguments its header lists.
- **Parser async retries are 0.** The BFF invokes the parser with `InvocationType=Event`; the
  default two retries would re-run the model behind the operator's back and could stage a second
  deal for the same email. Reparse is the intended retry.

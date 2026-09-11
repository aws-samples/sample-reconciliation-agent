# `infra/environments/deal-pipeline/` — the deal-pipeline demo root

Terraform root for the deal-pipeline demo described in `docs/deal-pipeline-design.md`. It creates
one S3 bucket, three DynamoDB tables, two AgentCore Memories, one SSM parameter and two Lambdas,
using `infra/modules/deal-pipeline` and the shared `infra/modules/lambda-package`.

State is **local** (no `backend` block): this is a single-developer demo that is applied and torn
down from one machine. Everything carries `Project = deal-pipeline-demo` and `ManagedBy = terraform`
through the provider's `default_tags`, so a tag search finds every resource this root made — the
cleanup story if a destroy is ever interrupted.

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
`.../prompts/assistant-system.md`. A plan that shows those warnings will deploy a parser with no
skills and no system prompt; add the files and apply again.

## Wire the frontend

Every value the BFF needs is an output; `env_local` renders the whole file:

```bash
terraform output -raw env_local > ../../../chatbot-app/frontend/.env.local
cd ../../../chatbot-app/frontend && npm run dev
```

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
  The assistant prompt and the security-master CSVs have no UI editor and *do* track the repo.
- **The Config tab owns the model parameter.** `/deal-pipeline-dev/agent-model-id` is seeded from
  `agent_model_id` and then ignored; change the model in the UI, not in tfvars.
- **Shared staging directory.** `lambda-package` stages into a directory under its own module path,
  shared by every root that uses the module. Plan/apply one root at a time from a single checkout.
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

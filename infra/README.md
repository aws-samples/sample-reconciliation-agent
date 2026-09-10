# `infra/` — Terraform

All infrastructure. There is no CDK in this repo.

```
environments/recon/   the root module — the only place you run terraform
modules/              one module per component, composed by the root
registry/definitions/ inherited scaffolding (a2a/, mcp/, skills/ YAML); nothing here reads it
bootstrap/            the state bucket, applied once before anything else
scripts/              operational tooling (deploy driver, seed push, resets)
```

## Where to run terraform

**`infra/environments/recon/` is the root module.** Running `terraform validate` from `infra/` passes
_vacuously_ — there is no configuration at that level, so it validates nothing:

```bash
cd infra/environments/recon
terraform init -backend=false      # no credentials needed
terraform validate
terraform fmt -check -recursive ../..
```

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

## Seeds

Some S3 objects are **create-only** and are not restored by a fresh apply — editable SKILL.md files,
the system prompts, harness config. `scripts/push_editable_seeds.py` implements the four-outcome
decision table (no-op, adopt, push, fail) and `tests/infra/` covers every branch.

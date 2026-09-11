# `infra/` — Terraform

All infrastructure. There is no CDK in this repo.

```
environments/recon/          the deployed platform: recon + (optionally) the deal-pipeline app
                             behind one console — the root CI plans and applies
environments/deal-pipeline/  the deal pipeline ALONE, local state, for laptop development of that
                             app (see its README); never applied by CI
modules/                     one module per component, composed by the roots
registry/definitions/        workflow-type definitions seeded into DynamoDB
bootstrap/                   the state bucket, applied once before anything else
scripts/                     operational tooling (deploy driver, seed push, resets)
```

## Where to run terraform

**`infra/environments/recon/` is the deployed root module.** Running `terraform validate` from
`infra/` passes _vacuously_ — there is no configuration at that level, so it validates nothing:

```bash
cd infra/environments/recon
terraform init -backend=false      # no credentials needed
terraform validate
terraform fmt -check -recursive ../..
```

`infra/environments/deal-pipeline/` is a second, standalone root for developing the deal-pipeline
app against real AWS resources from a laptop; the same module is composed into the recon root behind
`enable_deal_pipeline`, under a different name prefix so the two can coexist in one account.

## Module tests

Three modules carry `terraform test` suites, all plan-only under mocked providers (no credentials,
nothing created), and CI runs them beside the two validates:

```bash
for m in deal-pipeline frontend-ecs lambda-package; do
  (cd infra/modules/$m && terraform init -backend=false && terraform test)
done
```

- **`deal-pipeline/`** — each Lambda's role grants exactly what its handler calls, and every S3
  location a Lambda is given is one its role can read; the sample corpus seeds under the prefix the
  module outputs.
- **`frontend-ecs/`** — the deal-pipeline wiring: a recon-only console gets none of the pipeline
  environment or grants and is told `PIPELINE_ENABLED=false`, an enabled one gets exactly the
  documented variables and verb-per-resource grants that match what the BFF calls, and
  `pipeline_enabled` without the ARNs -- or with a blank access group -- fails at plan.
- **`lambda-package/`** — what changes the staging hash (every staged file, renames, the instance
  name) and what does not (bytecode caches, virtualenvs, OS and tool droppings such as `.DS_Store`),
  and that two instance names stage into two directories.

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

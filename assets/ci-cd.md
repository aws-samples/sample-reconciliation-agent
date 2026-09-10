# CI/CD

> Detail page for the [Reconciliation Workflow Agent](../README.md).

Two pipeline samples:

| File                       | Remote | Runs on              | Does                                                             |
| -------------------------- | ------ | -------------------- | ---------------------------------------------------------------- |
| `.github/workflows/ci.yml` | GitHub | every push, every PR | verification only — no AWS credentials in any job                |
| `.gitlab-ci.yml`           | GitLab | every MR, and `main` | the same verification plus SAST, then `plan` + `apply` on `main` |

On GitLab the pipeline is merge-request-only on feature branches, so open the MR as part of the push
and CI starts once, immediately:

```bash
git push -o merge_request.create -o merge_request.target=main \
         -o merge_request.remove_source_branch origin <branch>
```

Both run the same four checks as independent jobs, so a Terraform typo and a failing test report on
the same run instead of one masking the other:

| Job           | Command                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `python`      | `ruff check .` then `pytest -q` (full suite, nothing excluded)                          |
| `frontend`    | `npm ci`, `tsc --noEmit`, `vitest run`, `npm run build`                                 |
| `terraform`   | `terraform fmt -check -recursive infra/`, then `validate` in `infra/environments/recon` |
| `secret-scan` | `gitleaks` — the working tree on GitHub, the commit history on GitLab                   |

`terraform validate` only means something from the environment directory; run from `infra/` it passes
vacuously, because there is no root module there. `-backend=false` keeps it credential-free.
`secret-scan` installs no project dependencies on purpose: scanning after `npm ci` walks
`node_modules` and reports ~30 findings from vendored minified JS.

## Static analysis (GitLab only)

Two more jobs run in a `test` stage, which also gates `plan`. They are GitLab-only because the
scanner is a GitLab-bundled CI template, not something a GitHub workflow can include:

| Job            | Does                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `semgrep-sast` | `include: - template: Security/SAST.gitlab-ci.yml` — scans Python and TypeScript |
| `sast-gate`    | reads the report and fails on `Critical`/`High` that is not triaged              |

## GitLab CI/CD variables

Set these under Settings → CI/CD → Variables. None can be committed: the first two embed the AWS
account ID, and the repo's pre-push guard rejects any 12-digit run in a tracked file.

| Variable                | Type     | Value                                                                                                                   |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AWS_CREDS_TARGET_ROLE` | Variable | `arn:aws:iam::<account-id>:role/<ci-role>` — read by the runner's credential-vendor hook                                |
| `TF_STATE_BUCKET`       | Variable | the state bucket from step 1; the pipeline rebuilds `backend.hcl` from it                                               |
| `RECON_TFVARS`          | File     | the contents of `infra/environments/recon/terraform.tfvars` — holds the Entra client secret and the IDP MCP credentials |

Set all three with environment scope `*`: `terraform:apply` declares an environment but
`terraform:plan` declares none, so an environment-scoped variable would silently not reach the plan
job. `RECON_TFVARS` **cannot be masked**: GitLab
only masks single-line values, and a tfvars file is multi-line. Mark it **Protected** instead, which
restricts it to pipelines on protected branches — note that this also means a pipeline on an
unprotected branch cannot plan, which is usually what you want and is worth knowing when testing.

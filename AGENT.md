# AGENT.md — working in this repo

For coding agents and anyone new. [`README.md`](README.md) explains **what the platform is**; this
explains **how to change it without breaking something silently**. Everything here was learned the
hard way; none of it is inferable from reading the code.

## Layout

| Path                    | Guide                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `backend/`              | [Python Lambdas + libraries](backend/README.md)                          |
| `agent-blueprint/`      | [the two Tier-2 agent backends](agent-blueprint/README.md)               |
| `infra/`                | [Terraform](infra/README.md) — root module is `infra/environments/recon` |
| `tests/`                | [the Python suite](tests/README.md) — never beside the code              |
| `scripts/`              | [generators + live-deployment tooling](scripts/README.md)                |
| `data/`                 | [fixtures and the guidance corpus](data/README.md)                       |
| `chatbot-app/frontend/` | Next.js BFF + UI; tests in `__tests__/`, run with `npx vitest run`       |

## Commands that are actually the gate

```bash
python3 -m pytest tests/ -q                  # 1416 passed, 15 skipped, ~35s
python3 -m ruff check backend/ tests/        # lint
cd chatbot-app/frontend && npx vitest run    # 62 files, 874 tests
cd chatbot-app/frontend && npx tsc --noEmit  # typecheck
cd infra/environments/recon && terraform fmt -check -recursive ../..
```

Three traps:

- **`terraform validate` from `infra/` passes vacuously.** There is no configuration at that level.
  Run it from `infra/environments/recon`.
- **Repo-wide ESLint is broken.** Use `prettier` + `tsc --noEmit`; CI's `frontend` job is the real gate.
- **`ruff format` drift is pre-existing in 34 files.** Don't reformat them as a side effect — check
  whether a file was already drifting at `HEAD` before "fixing" it.

Every count above is a snapshot measured at `HEAD`, and **nothing asserts any of them.** They have
drifted apart three ways before (this file, `README.md` and `.gitlab-ci.yml` each quoted a different
number). Re-measure before you quote one, and read a disagreement as a stale line rather than as a
missing test.

## The one design rule everything else follows

**This platform prefers reporting "unavailable" over failing.** A field the source never carried, a
field extraction missed, and a field that came back blank are three different states, and collapsing
them loses information the agent acts on.

The consequence for you: **a wrong value and a missing one look identical downstream.** Nothing
reports the difference. So —

- Omit a key entirely for "not applicable to this class". Emit `""` for "the document says nothing
  here". Never emit a placeholder, a zero or a dash.
- `"searched, found nothing"` returns an empty result; **a read failure raises.** Conflating them
  makes a broken query look like a counterparty that does not exist.
- Never add a silent fallback or a default to keep code running. Raise.

## Git workflow

Worktrees per feature, at `<repo-root>/.worktrees/<branch-name>/` — a `PreToolUse` hook rejects any
other target. Never implement on `main`.

**Ship path is push → MR → green pipeline → merge the MR.** The merge _is_ the deploy trigger; a
local merge to `main` means no pipeline ever runs and nothing is applied, so the work looks shipped
and isn't.

⚠️ `docs/` is **gitignored**. Design docs and plans live only in the primary checkout; a fresh
worktree has no `docs/` at all, and no plan artifact ever reaches an MR. Don't cite a `docs/` path
from tracked code — it resolves to nothing in a clone.

## Deploys

CI owns `terraform apply`. It reconstructs `terraform.tfvars` from the protected `RECON_TFVARS` CI
variable and **does not read your working copy** — so editing the local file alone changes nothing,
and the next pipeline reverts whatever a local apply did.

The plain apply job fails on deletions by design; `terraform:apply:allow-destroy` is the manual
escape hatch. Read the plan before using it: the guard exists for the case where a truncated
`RECON_TFVARS` silently plans the Graph integration for destruction.

⚠️ **`*.tfplan` files are secret-bearing.** A binary plan stores every variable value in the clear,
including the ones declared `sensitive = true` — which is why CI archives only the redacted
`recon.plan.txt`. They are gitignored, so nothing stops one sitting in your checkout for weeks.
Delete them when you are done with them.

## What the repo cannot tell you

Four controls are set outside the tracked tree (protected `RECON_TFVARS`, or SSM at runtime), so a
local file is not evidence of what is live. Read them off the resource:

```bash
aws lambda get-function-configuration --function-name recon-dev-gw-interceptor \
  --query 'Environment.Variables.INTERCEPTOR_MODE'          # 'log' NEVER blocks
aws ssm get-parameter --name /recon-dev/agent-backend        # which backend you are debugging
aws ssm get-parameter --name /recon-dev/auto-resolve-threshold  # unreadable = human review
aws ssm get-parameter --name /recon-dev/tier1-enabled
```

The interceptor one matters most: it is the only place the provenance, evidence-quality and
case-transition guards are enforced, and in `log` mode all three degrade to observation while every
call still succeeds. Verified `enforce` on `recon-dev` on 2026-09-07.

## Where the real invariants live

Don't restate a rule in a second place — these are the single owners:

| Rule                                     | Owner                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Evidence-completeness scoring            | `backend/recon_core/confidence.py` (both agent backends import it)                       |
| The notice model and its store           | `backend/recon_core/notices.py`                                                          |
| Who the platform may email               | `recon-contacts` via the Config tab, and nowhere else                                    |
| Whether a counterparty send is permitted | the gateway REQUEST interceptor, and nowhere else                                        |
| What extraction must emit                | `data/input/IDP-EXTRACTION-REQUIREMENTS.md`, asserted both ways by `tests/input_corpus/` |
| The classification catalog               | `agent-blueprint/recon-agent/skills/*.md`                                                |

The email-domain allowlist is the cautionary tale: it was once read in four places, and the three
non-authoritative copies each read a container env var fixed at task start. A narrowed allowlist was
enforced by the interceptor while the UI still displayed the old one, and an out-of-domain contact
saved successfully but showed an amber warning that read as a failed save. **A control mirrored in
four places is a control that lies.**

## Names and language

- Systems are named by **generic role**, never by vendor or product — `tests/skills/` enforces the
  scrub. The corpus is published; a named system dates it and implies an endorsement.
- Every email address in `data/` must sit in an RFC 2606 / 6761 reserved domain
  (`.example`, `.example.com/.net/.org`). Secret scanners do not flag addresses, so these tests are
  the only defence, and all three of `data/input/`, `data/kb-seed/` and the rest of `data/` are
  swept. A tenant domain is the one exception, written as Microsoft's documentation placeholder
  `contoso.onmicrosoft.com`; the real one belongs in the gitignored tfvars and nowhere else.
- This is the first release. Nothing is "legacy", and there are no design-record or `§`-section
  references to a document outside the repo. If a comment needs a rule, state the rule.

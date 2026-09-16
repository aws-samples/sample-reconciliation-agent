# `scripts/` — repo-level tooling

Nothing here runs at deploy time. These are the generators behind committed fixtures and the tools
for poking a live deployment. Operational scripts that belong to the stack live in
[`../infra/scripts/`](../infra/scripts/) instead.

## Fixture generators — the source of truth for committed binaries

`data/` holds PDFs and spreadsheets that are **build products**, committed only so Terraform can
upload them without a toolchain. The content lives here as Python literals, so these scripts are
what you review and edit — never the binaries.

| Script                             | Produces                                                          | Verify with                     |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| `generate_input_notices.py`        | the synthetic agent-bank notices under `data/input/`              | `tests/input_corpus/`           |
| `generate_kb_email_attachments.py` | the PDF + XLSX attachments under `data/kb-seed/retrieved_emails/` | `--check`, and `tests/kb_seed/` |

Both are deterministic on purpose. Terraform tracks each seed object with `filemd5()`, so a
regenerated file whose bytes drift re-uploads and re-triggers a full knowledge-base ingestion for no
content change.

⚠️ **XLSX bytes are not reproducible across machines, and this is not fixable.** openpyxl
serialises XML through `lxml` when it is importable and the stdlib otherwise, and the two emit the
same tree as different bytes. So `--check` compares workbooks by _declared content_, and if you
regenerate one workbook expect to `git checkout --` the other. PDFs and HTML are compared
byte-for-byte.

## Live-deployment tools

| Script                           | Use                                                                                                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_tools_list.py`              | Dump the Gateway's live MCP tool surface (`tools/list`). What the model is actually offered — not what Terraform declares.                                                                                                                                                 |
| `mcp_tool_call.py`               | Invoke one tool (`tools/call`) and show the raw result.                                                                                                                                                                                                                    |
| `live_qa.py`                     | Drive a QA sweep over the deployed UI in a real browser. `--cases id1,id2,...` re-runs the per-case assertions across scenarios: one case is not coverage, because a class can be absent, a score can be zero and an evidence table can be legitimately empty.             |
| `capture_ui_screenshots.py`      | Refresh the screenshots in `assets/img/`.                                                                                                                                                                                                                                  |
| `push_idp_extraction_config.py`  | Install `data/idp-extraction-config/classes.json` into a live IDP configuration version. Rewrites the `classes` array only, backing up what was there; every other section of that config is the pipeline deployment's tuning and is left untouched.                       |
| `backfill_idp_document_index.py` | Add the `idp-document-index` key attributes (and the `record_kind` discriminator) to notice rows written before that GSI existed, which would otherwise be absent from the Documents tab. Attribute-only: creates no row, copies no S3 object, touches no extracted field. |
| `create_dev_users.py`            | Create the five demonstration operators in the console's Cognito user pool and put them in the console groups, so a fresh apply is signable-in and the per-app access model is visible in a browser. `--dry-run` first, `--delete` to clean up.                                                                                                                                                             |

### `create_dev_users.py` — making a fresh deployment signable-in

`auth_provider = "cognito"` (the default) creates the pool, its hosted UI and the five console groups
— and **no users**. Self sign-up is disabled deliberately, so a first apply ends with a console nobody
can open and a sign-in page that will not let anyone make themselves an account. Two things close
that gap, and they are for different people:

- `terraform output cognito_first_user_commands` in `infra/environments/recon` prints the two AWS CLI
  calls that create **one real operator** at an address that can receive mail.
- this script creates **five fictional accounts** that between them demonstrate every state the
  console can put a viewer in: recon only, pipeline only, admin of both, console admin with no app
  access, and no groups at all.

```bash
python3 scripts/create_dev_users.py --dry-run --profile <profile>          # read the pool, write nothing
python3 scripts/create_dev_users.py --profile <profile>                    # prompts for the password
python3 scripts/create_dev_users.py --generate-password --profile <profile> # prints one instead
python3 scripts/create_dev_users.py --delete --dry-run                     # then --delete
```

With no `--user-pool-id` it reads `cognito_user_pool_id` and `cognito_group_names` from
`terraform output -json` in `infra/environments/recon`, so a deployment that renamed a group is
followed without being told. `--user-pool-id` plus `--group <role>=<name>` covers a clone with no
state; the five roles are `recon-access`, `recon-admin`, `pipeline-access`, `pipeline-admin`,
`console-admin`.

Four things about it are decisions rather than details:

- **The addresses are not configurable.** All five are at `example.com`, which RFC 2606 reserves and
  which can receive no mail — so this script cannot email a real person, and `--delete` cannot remove
  a real operator's account. Someone who wants an account on a mailbox that exists uses
  `cognito_first_user_commands`, which takes the address as an argument for exactly that reason.
- **No invite is sent** (`MessageAction="SUPPRESS"`). The mail would carry the temporary password to
  five undeliverable addresses, and Cognito's own sender is capped at 50 messages a day per account.
  The password is therefore **printed** and that is the only copy — never a file, never a default,
  never a literal in this repo. `--generate-password` generates one that satisfies the pool's policy
  (12 characters, all four classes); otherwise the script prompts for one without echo. Every account
  lands in `FORCE_CHANGE_PASSWORD` and sets its own password at first sign-in.
- **Re-running is free.** It reads each account's real state and plans from that, so a second run
  reports five `UNCHANGED` and makes no write at all — which is what makes it the recovery from a
  partial failure. A group added outside the script is left alone unless `--prune-groups` says
  otherwise.
- **`--delete` removes accounts and never a group.** The five groups belong to
  `infra/modules/console-auth`; deleting one here would leave the next plan recreating a group whose
  membership had been silently emptied.

`tests/scripts/test_create_dev_users.py` covers the pure logic against a fake `cognito-idp` client
and asserts the script's copy of the five default group names still equals the ones
`infra/modules/console-auth/variables.tf` declares — a drifted copy is answered by Cognito with a
`ResourceNotFoundException` naming a *group*, never naming this script.

An Okta or Entra deployment has no pool of its own, so the script exits 2 naming `auth_provider`
rather than reporting a missing output.

`live_qa.py` and `capture_ui_screenshots.py` need `pip install playwright` (deliberately not in `requirements-dev.txt`: no test
imports it, so pinning it there would make every CI run download a browser-automation stack for
nothing). They attach to a **running** Chrome over CDP rather than launching one, because every
`/recon` screen is gated by `src/proxy.ts` behind whichever provider `AUTH_PROVIDER` names — Cognito's
hosted UI by default, Okta or Entra when either is selected — and a fresh browser has no session.
Start Chrome with a debugging port, then **sign in once in that window before running either
script**:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir=/tmp/recon-qa-chrome-profile
```

The separate `--user-data-dir` keeps the sweep off your day-to-day profile, but it is empty on first
use — so the sign-in is not optional setup you can skip, it is the step that gives this profile the
session the scripts inherit. Skip it and every check reports "redirected to a login wall". The
profile does persist between runs, so later sweeps reuse the session until it expires.

⚠️ The provider session is short lived and **expires mid-run**. Both scripts re-check that the app —
not the login wall — is on screen before every assertion and every capture. That guard is not
defensive padding: check once at startup instead and a sweep that loses its session mid-run writes
seven screenshots of the provider's sign-in page, which is worse than failing, because a login wall is
a plausible-looking image nobody questions in a README. Under Cognito the window is the app client's
token validity — 60 minutes for the ID and access tokens, 1 day for the refresh token, as
`infra/modules/console-auth` sets them. One extra thing to know there: the console holds those tokens
in `sessionStorage` (`src/lib/auth/cognito-pkce.ts`), which is per-tab, so a page opened in a **new**
tab bounces through the hosted UI once. That bounce is silent while the pool's own session cookie in
the profile is still valid — which is another reason the sign-in has to happen in the same profile the
script drives.

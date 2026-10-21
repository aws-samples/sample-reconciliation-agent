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
| `seed_recon_demo_items.py`       | Write six fictional `ReconItem` rows into the recon items table so a fresh apply has a queue, a dashboard and six case screens instead of nothing. Items, not cases: an item write is what runs Tier-1. `--dry-run` first, `--delete` to clean up.                                                                                                                                                       |

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
AWS_PROFILE=<profile> python3 scripts/create_dev_users.py --dry-run           # read the pool, write nothing
AWS_PROFILE=<profile> python3 scripts/create_dev_users.py                     # prompts for the password
AWS_PROFILE=<profile> python3 scripts/create_dev_users.py --delete --dry-run  # then --delete
```

With no `--user-pool-id` it reads `cognito_user_pool_id` and `cognito_group_names` from
`terraform output -json` in `infra/environments/recon`, so a deployment that renamed a group is
followed without being told. `--user-pool-id` plus `--group <role>=<name>` covers a clone with no
state; the five roles are `recon-access`, `recon-admin`, `pipeline-access`, `pipeline-admin`,
`console-admin`.

⚠️ **`AWS_PROFILE`, not `--profile`, when the script resolves anything from Terraform.** Both scripts
accept `--profile`, and both hand it only to `boto3.Session` — never to the `terraform` subprocess they
shell out to first. The recon root's state is remote (`backend "s3"`), so that read needs credentials
of its own and takes them from the ambient environment. Exporting `AWS_PROFILE` covers both halves;
`--profile` alone covers the second half and silently leaves the first on your default credentials.
With `--user-pool-id` / `--items-table` there is no Terraform read and `--profile` is sufficient.

Four things about it are decisions rather than details:

- **The addresses are not configurable.** All five are at `example.com`, which RFC 2606 reserves and
  which can receive no mail — so this script cannot email a real person, and `--delete` cannot remove
  a real operator's account. Someone who wants an account on a mailbox that exists uses
  `cognito_first_user_commands`, which takes the address as an argument for exactly that reason.
- **No invite is sent** (`MessageAction="SUPPRESS"`). The mail would carry the temporary password to
  five undeliverable addresses, and Cognito's own sender is capped at 50 messages a day per account.
  The operator therefore **supplies** the password: the script prompts for it twice without echo,
  checks it against the pool's policy (12 characters, all four classes) before making any API call,
  and then never writes it anywhere — not stdout, not a file, not a default, not a literal in this
  repo. There is deliberately no flag that generates one, because a generated password is only usable
  if it is echoed back, and a secret on stdout is a secret in scrollback, in a redirect, and in a CI
  log. Every account lands in `FORCE_CHANGE_PASSWORD` and sets its own password at first sign-in.
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

### `seed_recon_demo_items.py` — giving a fresh deployment something to reconcile

The Deal Pipeline app seeds its own demo corpus at apply time, so it demonstrates itself. Recon does
not: a `ReconItem` row arrives only from the intake API or a structured feed, so a first apply ends
with an empty queue, an empty dashboard and no case to open — which is indistinguishable from a broken
deployment. This writes six items that between them land in **six visibly different outcomes**: two
auto-clear on two different paths, and four escalate naming four different reasons.
[Step 5 of Getting Started](../README.md#5-give-recon-something-to-reconcile) is the same list written
as "what you should see in the console, and where".

```bash
AWS_PROFILE=<profile> python3 scripts/seed_recon_demo_items.py --dry-run   # print the rows, write nothing
AWS_PROFILE=<profile> python3 scripts/seed_recon_demo_items.py             # seed all six
AWS_PROFILE=<profile> python3 scripts/seed_recon_demo_items.py --scenario ledger-match  # or one at a time
AWS_PROFILE=<profile> python3 scripts/seed_recon_demo_items.py --delete --dry-run       # then --delete
```

| Scenario              | Tier-1 does                            | Why                                                   |
| --------------------- | -------------------------------------- | ----------------------------------------------------- |
| `autoclear-interest`  | `AUTO_CLEARED` / `amount-match`        | two sides differing by 0.02, inside the 0.05 tolerance |
| `amount-mismatch`     | `PENDING` / `tolerance_miss`           | two sides differing by 3,655.20                        |
| `ledger-match`        | `AUTO_CLEARED` / `gl-match`            | no sides; exactly ONE mocked-ledger row matches        |
| `ledger-ambiguous`    | `PENDING` / `gl_ambiguous`             | no sides; TWO ledger rows match, under one wire        |
| `missing-amount`      | `PENDING` / `missing_match_attr`       | the expected side omits `amount` entirely              |
| `unparseable-amount`  | `PENDING` / `unparseable_amount`       | the expected side says `n/a` where a number belongs    |

Four things about it are decisions rather than details:

- **It writes items, never cases.** `recon-<env>-items` is the platform's only stream-enabled table and
  an item write is what opens a case, so Tier-1 decides each outcome itself and the case rows carry the
  real `tier1_match` evidence, escalation reason and break-type hint. Writing cases directly would
  produce six rows nothing had reasoned about, and nothing would ever dispatch the agent.
- **Every figure comes from the mocked ledger.** The borrowers, amounts, facilities and wire references
  are read off `data/general-ledger/gl-entries.csv`, so the two sides-less items match rows that really
  exist and the agent's `search_ledger` calls return something. `tests/scripts/test_seed_recon_demo_items.py`
  re-parses that CSV and runs the real `gl_lookup` over the seeded items, so a scenario cannot quietly
  stop being the case it claims to be. The names are this repo's own fictional corpus — the agent bank
  is the one `generate_input_notices.py` prints — and no real institution appears.
- **Re-running is free.** The ids are derived from a fixed prefix and ordinal, with no clock and no
  uuid, and the write is the same conditional put intake uses, so a second run reports six `SKIP` and
  never re-fires Tier-1 for an item already in flight.
- **`--delete` removes the items and no case row.** It deletes by exact key and refuses any id outside
  its own prefix, so it never scans and can never remove a row an analyst or the intake API wrote. The
  cases Tier-1 derived stay, which means "delete then re-seed" does **not** reset the demo —
  `CaseStore.open` is conditional on the case id, which is the item id, so Tier-1 reports
  `DUPLICATE_SKIPPED` and the console keeps the original six cases. The delete run prints the
  `aws dynamodb delete-item` calls for those case rows if you do want to replay from scratch.

With no `--items-table` it reads the `items_table` Terraform output from `infra/environments/recon`,
which the recon root now re-exports from `infra/modules/foundation` — so a deployment under any
`name_prefix` is followed without being told. `--items-table <name>` covers a checkout with no state (the
table is `<name_prefix>-items`) and is also how a test points the script at a moto table. That
Terraform read happens even under `--dry-run` and needs credentials of its own — see the `AWS_PROFILE`
note above; only the `--items-table` form is genuinely credential-free. ⚠️ The script's own docstring
and the error message in `resolve_items_table` still say the root does not export it; both predate the
output and are stale, not a description of today.

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

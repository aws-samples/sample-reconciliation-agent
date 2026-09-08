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

| Script                      | Use                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_tools_list.py`         | Dump the Gateway's live MCP tool surface (`tools/list`). What the model is actually offered — not what Terraform declares.                                                                                                                                     |
| `mcp_tool_call.py`          | Invoke one tool (`tools/call`) and show the raw result.                                                                                                                                                                                                        |
| `live_qa.py`                | Drive a QA sweep over the deployed UI in a real browser. `--cases id1,id2,...` re-runs the per-case assertions across scenarios: one case is not coverage, because a class can be absent, a score can be zero and an evidence table can be legitimately empty. |
| `capture_ui_screenshots.py` | Refresh the screenshots in `assets/img/`.                                                                                                                                                                                                                      |

The last two attach to a **running** Chrome over CDP rather than launching one, because every
`/recon` screen is gated by `src/proxy.ts` behind Okta and a fresh browser has no session. Start
Chrome with a debugging port on a profile that is already signed in:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir=/tmp/recon-qa-chrome-profile
```

⚠️ The provider session is short lived and **expires mid-run**. Both scripts re-check that the app —
not the login wall — is on screen before every assertion and every capture. That guard is not
defensive padding: an earlier version checked once at startup and wrote seven screenshots of the
Okta sign-in page, which is worse than failing, because a login wall is a plausible-looking image
nobody questions in a README.

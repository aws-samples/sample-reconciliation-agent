# `tests/` — the Python suite

Tests live here and **never beside the code they test**. `tests/<package>/` mirrors
`backend/<package>/`, so `backend/idp_hook/mapper.py` is covered by `tests/idp_hook/test_mapper*.py`.

```bash
python3 -m pytest tests/ -q                    # whole suite
python3 -m pytest tests/kb_seed/ -q            # one area
python3 -m ruff check backend/ tests/          # lint
```

## Suites that are not a mirror of a package

| Suite                  | Guards                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input_corpus/`        | that `data/input/`'s committed PDFs still match `scripts/generate_input_notices.py`, and that the extraction-requirements doc and the hook's mapper agree **in both directions** |
| `kb_seed/`             | the knowledge-base corpus: metadata sidecar shape, break-class coverage, and that the committed PDF/XLSX attachments parse and match their generator                             |
| `skills/`              | the SKILL.md catalog — that declared evidence steps are consistent, and the six-required-step ceiling                                                                            |
| `infra/`               | pure-Python logic that ships inside Terraform modules, e.g. the seed-push decision table                                                                                         |
| `e2e/`, `integration/` | multi-component paths that still run offline against fakes                                                                                                                       |

## What the tests here are for

Most of this suite exists because of a specific class of bug: **the platform prefers reporting
"unavailable" over failing**, so a wrong value and a missing one look identical downstream. A test
that only asserts "not null" would pass on either.

So the conventions are:

- **Assert the message, not just the branch.** A refusal's text is its entire product; `not null`
  tells an analyst nothing.
- **Absence assertions need a loaded-ness guard.** `expect(x).not.toContain("banner")` is satisfied
  for free by a page that failed to render. Assert the screen loaded _first_.
- **Test names say the invariant, not the mechanism.** `test_snakecase_shape_is_supported`, not
  `test_mapper_2`.
- **A comment on a test should say what breaks in production if it fails.** Several here record the
  incident that produced them — a 0.40 error in a fixture total, a regex backreference that
  corrupted `docProps/core.xml` while a determinism check passed.

⚠️ **Two IDP event shapes are both current.** A snake_case Step Functions event and a PascalCase
tracking record are _both_ received by the hook; neither is legacy and neither is a fallback for the
other. A test named as if one were deprecated invites someone to delete live support.

## Frontend tests

Not here — `chatbot-app/frontend/__tests__/` (vitest), run with `npx vitest run` from that
directory. CI's `frontend` job is the real gate for that half; repo-wide ESLint is broken, so use
`prettier` + `tsc --noEmit`.

# IDP evaluation artefacts

⚠️ **Everything under this folder is generated. Nothing here is a source document, and nothing here
should be hand-edited.** It is the notice corpus in `data/input/` republished in the two forms the
GenAI IDP accelerator accepts as evaluation ground truth, with a generated baseline beside each PDF.

```
data/input/idp-evaluation/
├── testsets/        one zip per notice family      -> "Add Test Set from Upload"
└── ground-truth/    input/ + baseline/ S3 trees    -> aws s3 sync to the two buckets
```

Both cover the same 16 documents with the same ground truth; the per-section `result.json` files are
byte-identical between them. Only the layout and the delivery differ. Each subfolder has its own
README with the details.

## This is not a document family

`data/input/`'s other subfolders are notice families, one per documented class in
[`../IDP-EXTRACTION-REQUIREMENTS.md`](../IDP-EXTRACTION-REQUIREMENTS.md). This one is not: it is
derived output, regrouped by test-set family rather than by class, and every PDF under it is a copy of
one already sitting in a family folder. `tests/input_corpus/test_extraction_requirements.py` exempts it
by name for that reason (`NON_FAMILY_FOLDERS`) — adding a real family here would slip past that guard,
so put new source documents in a class folder, never in here.

## The generator lives in another repo

The ground truth for all 16 documents is declared as data in **one** table, `TRUTH`, in the
`genai-idp-terraform` repo:

```
genai-idp-terraform/scripts/build_loan_notice_testsets.py       # TRUTH + the test-set form
genai-idp-terraform/scripts/build_loan_notice_ground_truth.py   # imports TRUTH; the bucket form
```

Regenerate everything here by running both from that repo — they default to writing into a sibling
checkout's `data/input/idp-evaluation/`, which is this folder:

```bash
python3 scripts/build_loan_notice_testsets.py
python3 scripts/build_loan_notice_ground_truth.py
```

Point `--source-dir` at a corpus elsewhere and the output moves with it.

**The split is worth knowing about**: the artefacts are committed here, the code that produces them is
not. A value corrected in a `result.json` under this folder loses the note recording how it was decided
and is reverted by the next regeneration. Fix `TRUTH` instead.

The `.zip` files under `testsets/` are excluded by `.gitignore` — they are pure derivatives of the
trees beside them, so the tracked copy would be redundant. Run the generator to get them.

## Handling

Synthetic throughout: fictional borrowers, agents and funds, with email addresses on RFC 2606/6761
reserved domains that cannot resolve. No customer data, safe to upload to an accelerator deployment.

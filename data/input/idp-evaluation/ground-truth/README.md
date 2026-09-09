# Loan-notice ground-truth dataset

The same 16 syndicated-loan notices and the same ground truth as
[`../testsets/`](../testsets/README.md), in the accelerator's **other**
evaluation form — the input bucket plus the evaluation baseline bucket.

| Mechanism                     | Layout                                                                 | Delivery                         | What it gets you                                                              |
| ----------------------------- | ---------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| **Test set** (`../testsets/`) | `<FAMILY>/input/` + `<FAMILY>/baseline/`, one zip per family           | Add Test Set from Upload         | A named, re-runnable set. Nothing touches the live input bucket.              |
| **Ground truth** (here)       | `input/<FAMILY>/<doc>.pdf` + `baseline/<FAMILY>/<doc>.pdf/sections/1/` | `aws s3 sync` to the two buckets | Live pipeline runs evaluate automatically; test sets can be carved out later. |

The per-section `result.json` is **byte-identical** between the two — verified, all 16. Only the layout
and the delivery differ, so a score difference between the two mechanisms is never the ground truth.

| Family                | Docs | Classes                                                                         |
| --------------------- | ---: | ------------------------------------------------------------------------------- |
| `01-BORROWING`        |    1 | `borrowing_notice`                                                              |
| `02-INTEREST-RATESET` |    6 | `interest_rate_set_notice`, `commitment_fee_notice`, `rollover_rate_set_notice` |
| `03-PAYDOWN`          |    4 | `paydown_notice`                                                                |
| `04-CANCELLATION`     |    1 | `cancellation_notice`                                                           |
| `05-AGGREGATED-WIRE`  |    3 | `consolidated_payment_advice`, `activity_memo`, `summary_statement`             |
| `06-INCOMPLETE`       |    1 | `incomplete_notice`                                                             |

## ⚠️ The baseline key is the input object key, exactly

```
<InputBucket>/03-PAYDOWN/Mandatory Paydown Notice.pdf
<EvaluationBaselineBucket>/03-PAYDOWN/Mandatory Paydown Notice.pdf/sections/1/result.json
                          └─────────── identical to the input key ───────────┘
```

The lookup is a literal `list_objects_v2(Prefix=f"{input_key}/")` against the baseline bucket
(`genai-idp-terraform`, `sources/src/lambda/test_set_file_copier/index.py:72`). Upload a PDF under any other prefix — drop the
family folder, add one of your own, rename the file — and its ground truth is simply not found.

**And the miss is silent.** On the input-bucket path a missing baseline is treated as normal and the
document is _skipped_, because partial ground truth is expected there (same file, lines 88–93). A
misplaced upload therefore shrinks the evaluated set rather than failing. That is why both trees are
generated together from one relative path each: get the sync right and the keys cannot disagree.

## Uploading

Bucket names come from your stack outputs. Sync the **baseline first** — a document that lands in the
input bucket starts processing immediately, and if its baseline is not there yet the run is evaluated
against nothing:

```bash
aws s3 sync data/input/idp-evaluation/ground-truth/baseline/ s3://<EvaluationBaselineBucket>/ --profile <your-profile>
aws s3 sync data/input/idp-evaluation/ground-truth/input/    s3://<InputBucket>/               --profile <your-profile>
```

Run from the repo root; the generator's `--print-sync-commands` prints the same two lines with absolute
paths filled in. The generator never uploads anything itself: which deployment receives the dataset is
the operator's call.

## Carving test sets back out

The `<FAMILY>/` prefix is load-bearing here too. **Create Test Set from Input Bucket** takes a file
pattern whose `*` does not cross `/`, so one glob is exactly one family:

```
01-BORROWING/*.pdf
02-INTEREST-RATESET/*.pdf
```

This is the bridge between the two mechanisms: sync the ground truth once, then create per-family test
sets from it without re-uploading anything.

## Regenerating

The generator lives in the **`genai-idp-terraform` repo**, not this one; run it from there and it writes
back into this folder (see [`../README.md`](../README.md)):

```bash
python3 scripts/build_loan_notice_ground_truth.py
```

Never hand-edit anything under this directory. The ground truth lives in **one** place — the `TRUTH`
table in that repo's `scripts/build_loan_notice_testsets.py`, which this script imports rather than
restating. Two copies of sixteen documents' field values drift, and the drift surfaces as an unexplained
score gap between two mechanisms that should agree exactly.

The build fails on a missing document and on a page count that disagrees with the declared one.

## Everything else

The baseline shape, the authoring conventions, the three self-contradictions in the source extraction
contract, the per-document "what it is for" table, and the note that **no matching extraction
configuration exists yet** (so this scores 0 today) are all in
[`../testsets/README.md`](../testsets/README.md). They apply unchanged.

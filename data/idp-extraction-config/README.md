# `idp-extraction-config/` — the extraction schema, tracked

`classes.json` is the class-schema half of the document pipeline's extraction configuration: one JSON
Schema per document class, keyed by `$id`, with each property's `description` carrying the extraction
instruction for that field. It is the machine-readable counterpart of
[`../input/IDP-EXTRACTION-REQUIREMENTS.md`](../input/IDP-EXTRACTION-REQUIREMENTS.md), which stays the
contract; this is one configuration that satisfies it.

## Why it is in the repo

Its other home is the pipeline deployment's DynamoDB configuration table. Live there alone, with
nothing in the repo describing it, it cannot be reviewed, diffed or rebuilt — so it drifts.

Drift looks like this. A configuration classifies a paydown notice as `LoanPrincipalPaymentNotice`
and emits `NoticeDate` (in US month-first order), `EffectiveDate`, `RecipientShareAmount` and
`Borrower.BorrowerName`, and never extracts `reference` or `fund` at all. Meanwhile the contract, the
mapper and every test in this repo agree with each other and pass. The hook reads by **literal key
name**, so extraction finds the right values, emits them under names nothing reads, and every field
arrives as `fields_unavailable` — which the agent reads as "this notice class does not carry that
field", not as a fault. The evidence steps that come back empty are the ones whose inputs were never
extracted, and nothing fails anywhere, because there is nothing to compare against.

That is what tracking the file here buys: `tests/input_corpus/test_extraction_config.py` holds it
against the contract and against the corpus ground truth, in both directions.

## What it does NOT cover

Only `classes`. Models, prompts, OCR backend, assessment thresholds, discovery rules and pricing are
the pipeline deployment's own tuning, and `scripts/push_idp_extraction_config.py` reads them back and
rewrites them untouched. So this artifact **cannot create** a configuration version — a config with
classes and no extraction model would look installed and extract nothing.

That split is deliberate: the class schemas are the part the platform has a contract about, and the
part whose drift is invisible. A wrong model produces visibly bad extraction; a wrong key produces
perfect extraction that lands nowhere.

## Pushing it

```bash
python3 scripts/push_idp_extraction_config.py --table idp-configuration-table-XXXXXXXX \
    --profile <profile> --region us-east-1 --dry-run   # then drop --dry-run
```

The script backs the previous configuration up to `Config#<name>-prepush-<UTC>` (marked inactive)
before writing, and prints the change per class and per field key.

⚠️ **A push does not re-extract anything.** Documents already processed keep the fields they were
extracted with, so a notice that failed to ingest before a push still has no usable date after one.
Re-upload the document.

⚠️ **Push to the configuration version the uploads actually name** — the one in
`seed_extraction_config_version`, read off the console's Documents tab. Pushing to a different
version succeeds and changes nothing observable.

## Two things that look like bugs and are not

**`incomplete_notice` has no `notice_date`, so its documents dead-letter.** A truncated fax cover
carries a borrower name and a letterhead; the ground truth for `Agent Notice - Partial Fax Cover.pdf`
has three fields and no date of any kind. The mapper raises when neither `notice_date` nor
`value_date` is extracted, so such a document is retried and dropped — which the contract states
outright (§2). Giving the class a date property would not put a date on the page; it would invite the
model to infer one, and a confident wrong date on a document whose defining property is that it is
unreadable is worse than no notice.

**`activity_memo` and `consolidated_payment_advice` have no `global_amount`.** Neither document prints
a `Global Amount` / `Your Share` pair. The consolidated advice prints a wire total across facilities,
and that total **is** the fund's money — offering a `global_amount` key there would invite the model
to file it as a facility-wide figure, which is §5's error in the opposite direction.

## Editing it

Edit the JSON, keep it canonical (`json.dumps(..., indent=2, sort_keys=True, ensure_ascii=False)` —
a test asserts this, because the descriptions are prose and review happens in the diff), run
`pytest tests/input_corpus/`, then push. A class or field key that is not in the contract fails the
test: add it to the contract first, with a sample document.

Never let a **blueprint-discovery** job write this configuration version. Discovery appends whatever
it inferred from the sample it was handed; the drifted config had accumulated 23 classes that way —
payslips, W2s and driving licences alongside near-duplicate loan classes whose names collided
(`ActivityMemo` and `Activity_Memo`, `LoanRateNotice` and `LoanRateSettingNotice`). The `notes` field
on the live configuration says so, and `enable_blueprint_optimization` is off.

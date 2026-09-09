# IDP extraction-improvement prompt

A reusable prompt for iteratively improving loan-notice field extraction in the
deployed IDP pipeline. Paste the fenced block below as the task.

---

```
Iteratively improve loan-notice field extraction in the deployed IDP pipeline until
it clears both quality gates below. Work in a git worktree at
.worktrees/recon-extraction-accuracy/; never on main.

## Environment

Account XXX, XXX, --profile XXX. `aws dynamodb` calls REQUIRE
--region XXX or they return a misleading ResourceNotFoundException.

  config table      (to be retrieved)
  output bucket     (to be retrieved)
  input bucket      (to be retrieved)
  baseline bucket   (to be retrieved)  (always prefix-scope)


## Review phase — do all four before changing anything

a) Source corpus. Read every file in the subfolder in /data/input,
   including IDP-EXTRACTION-REQUIREMENTS.md, which is the contract: it defines the
   permitted class ids and field keys. Note any document type or field present in
   the corpus that the contract or the config does not cover.

b) Uploaded test sets. List the current run prefixes in the input and baseline
   buckets and reconcile them against the corpus from (a). Report any document
   that exists on disk but has no test-set entry, or has an input but no
   ground-truth baseline — those silently drop out of every score.

c) Deployed classes. Decode the active Config#Recon-IDP payload (it is gzipped
   JSON in the `_compressed_config` Binary attribute; boto3 returns a Binary
   wrapper, use .value) and compare its classes and per-class field sets against
   the contract and against the classes actually present in the baselines. Report
   drift in either direction: a class the config emits that ground truth never
   uses, and a field ground truth carries that the class omits.

d) Current results. Run scripts/recon/field_error_report.py over the most recent
   run prefixes for per-field, per-error-kind accuracy, and
   scripts/recon/score_recon_results.py for the pipeline's own weighted score.
   Then extend the measurement to confidence: per-field `confidence` lives in
   `explainability_info` in each sections/N/result.json, alongside the configured
   `confidence_threshold` (currently 0.8).

## Gates — both must hold, measured over all 16 documents

  GATE 1  at least 90% of expected fields extracted CORRECTLY, judged against the
          ground-truth baselines (field_error_report.py's accuracy figure)
  GATE 2  at least 90% of extracted fields carry confidence > 0.90

Report both every iteration, and report them separately. They are independent
signals and must not be collapsed into one number: the assessment stage scores its
own output, so a field can be confidently wrong. `agent_contact_name` currently
reports 0.95 confidence on documents where the value is absent or wrong. If GATE 2
passes while GATE 1 fails, treat that as a calibration finding worth reporting in
its own right, not as progress.

Build a confidence report analogous to field_error_report.py — per field, the count
and distribution of confidence scores, cross-tabulated against whether the value
was actually correct. The cross-tab is the point: it tells you which fields are
confidently wrong, which is where the real defects are.

## Iteration protocol

Each cycle, in order:

1. Form ONE hypothesis about a general cause, ranked by how many errors it
   explains. Confirm it by reading the page's own OCR text
   (pages/N/result.json in the output bucket) before writing any fix. Diagnose
   which STAGE the value first goes wrong in — OCR, classification, extraction or
   assessment. A rule aimed at the wrong stage cannot work: a transcription rule
   was once added to the extraction prompt for a name that OCR had already
   mangled, and it did nothing.
2. Check for a competing instruction at broader scope before rewriting any field
   description. A global prompt rule outranks a per-field one — that is what kept
   21 date values wrong despite an explicit per-field ISO rule. Consistency is the
   tell: many values wrong in the same direction means a competing rule, not an
   inattentive model.
3. Build a new config version with scripts/recon/build_recon_idp_v2_config.py
   --target Config#Recon-IDP-v<n+1>. Never edit Config#Recon-IDP in place; keeping
   one version per hypothesis is what makes a measured delta attributable.
4. Run scripts/recon/rerun_recon_testsets.py --config-version Recon-IDP-v<n+1>.
   This starts real inference and costs money. Wait ~5 minutes.
5. Re-measure both gates. Record the delta in a table against the previous
   version.
6. If a change made things worse, REVERT it and say so. Do not keep a change
   because it was your idea. Two such reverts are already documented; that is
   normal.

Commit each cycle with a [Fix] or [Docs] prefix and the measured numbers in the
message.

## Constraints

- Fix GENERAL causes, not individual documents. Tuning a field description until
  it reproduces ground truth on one PDF is overfitting and will not survive a new
  document. Every change must be justified by what the page actually prints, and
  state the general rule it encodes.
- Do not modify the ground-truth baselines to make scores go up. If a baseline
  looks genuinely wrong, report it and leave it — changing the target instead of
  the system is the one move that invalidates every future measurement. Ground
  truth is inconsistent for activity_type; that is a finding to surface, not a
  file to edit.
- No real email addresses in data/input — RFC 2606/6761 reserved domains only.
- Python: docstring on every function documenting purpose/params/return, explicit
  type annotations, named parameters, fail loudly (no silent fallbacks or default
  values), comment non-obvious code, ruff for lint and format. Scripts go in
  scripts/recon/; tests in tests/, never co-located.
- Promote to the active Config#Recon-IDP only after a version clears both gates,
  using scripts/recon/promote_config_version.py. It preserves IsActive (a wholesale
  item overwrite drops it and deactivates the config) and backs up the prior
  payload first.

## Stopping

Stop when both gates hold, or after 5 cycles without a net improvement. If you
stop short, state plainly which gate failed, the final numbers, and which
remaining causes are not addressable in the config layer — some are not. Known
examples: activity_type's ground truth is internally inconsistent and needs a
controlled vocabulary agreed with the platform; notice_comment is free text under
LLM evaluation. Do not report success on a partial result, and do not claim a gate
passed without showing the measurement.

Finish with a design doc at docs/plans/YYYY-MM-DD-<feature>-design.md covering
what was reviewed, each hypothesis and its measured outcome (including failures),
and what remains. Merge to main with --no-ff and remove the worktree.
```
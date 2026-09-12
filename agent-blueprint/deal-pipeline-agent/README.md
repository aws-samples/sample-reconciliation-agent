# `agent-blueprint/deal-pipeline-agent/` — the deal pipeline agent's knowledge

Everything the deal-pipeline agents *know* lives here as Markdown: the skills the parsing agent
loads at every run, the parsing agent's system prompt, and the desk assistant's system prompt. No
code. The runtime (`backend/deal_pipeline/`) and the UI (`chatbot-app/frontend`) load these files
from S3; this directory is the **seed**, and `docs/deal-pipeline-design.md` is the contract they
are written against.

```
skills/
  deal-parsing/SKILL.md         core: universal rules + the complete field mapping + a worked example
  news-alert-format/SKILL.md    format: reading a prose market news alert
  bank-notice-format/SKILL.md   format: reading an arranger's term-sheet notice (incl. forwards)
  oms-csv-format/SKILL.md       reference: the staging CSV contract (column order, formats, enums)
prompts/
  parser-system.md              system prompt for the parsing agent (Lambda `<name_prefix>-pipeline-parser`)
  assistant-system.md           system prompt for the desk assistant (BFF `/api/pipeline/chat`)
```

## What each file is for

| File                                   | Read by                       | Purpose                                                                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/deal-parsing/SKILL.md`         | parsing agent, assistant, UI  | The desk's standing instructions: instrument classification, number/date conventions, naming, ratings, the field-by-field mapping for every email- and lookup-sourced OMS field, defaults, and the evidence/confidence discipline. An analyst can read it and hand-produce the CSV for a sample email. |
| `skills/news-alert-format/SKILL.md`    | parsing agent, `news-alert` emails only  | Where each fact sits in a prose wire: sentence patterns for launch, arrangers, talk, fungibility, deadlines and ratings; the Entity/Topic footer; what to ignore.                                                                          |
| `skills/bank-notice-format/SKILL.md`   | parsing agent, `bank-notice` emails only | How to read a `Label: value` term sheet, forwarded-message headers (the original sender's bank is the arranger; the forwarder is not a counterparty), lead-left markers, Administrative Agent vs bookrunners, `TBA` ratings, timing lines. |
| `skills/oms-csv-format/SKILL.md`       | parsing agent, assistant      | The output contract: all 74 columns in `oms_fields.json` order, the exact format per type, enum spellings verbatim, the two defaults, blanks and quoting.                                                                                 |
| `prompts/parser-system.md`             | parsing agent                 | Role, the fixed process (memories first, then skills, one `lookup_security_master` call, one `stage_deal` call), the evidence payload, and the rule that a field with no rule stays blank.                                                  |
| `prompts/assistant-system.md`          | assistant                     | Role, the two knowledge tiers and how to classify a fix between them, the tool list and when to use each, the upload-failure procedure, and how to write a skill proposal or a memory.                                                    |

## Skill frontmatter

Each `SKILL.md` opens with a small YAML block:

```yaml
---
name: deal-parsing
description: Core rules for turning one new-issue deal email into one OMS record.
metadata: { tier: "core", applies_to: ["news-alert", "bank-notice"] }
---
```

- `name` is the skill's id and its S3 folder name. `description` is one line.
- `metadata.tier` says what kind of skill it is: `core` (the universal rules), `format` (how to
  read one kind of email) or `reference` (the output contract).
- `metadata.applies_to` lists the `source_kind` values (design §4: `news-alert`, `bank-notice`)
  the skill is for. **This is the field the parser filters on.** At each run it lists every skill
  under `skills/` and drops a `format` skill whose `applies_to` does not include the email's
  `source_kind`, so a bank notice is parsed with `deal-parsing`, `bank-notice-format` and
  `oms-csv-format` and never sees `news-alert-format`. `core` and `reference` skills are loaded
  whatever their `applies_to` says, and a skill with no `metadata` line (or no `tier` /
  `applies_to` in it) is never dropped, so a hand-written SKILL.md still reaches the model. A
  `manual` email, or one with no `source_kind`, loads every skill: nobody has said which format it
  follows. `skills_used` on the parse output (design §4) records which skills a given email
  actually got.

The block is YAML, read by the parser both apps share (`backend/recon_core/skill_meta.py`,
`yaml.safe_load`; the pipeline calls it through `backend/deal_pipeline/skills_loader.py`), so a
SKILL.md means the same thing here as in the recon app. `metadata` may be written either way — the
one-line flow style above, which the seeds use, or as a block:

```yaml
metadata:
  tier: format
  applies_to: [bank-notice]
```

Both parse to the same record. Three rules still apply.

- The block ends at the first `---` after the opening fence wherever it sits. A value that is
  entirely a quoted string containing `---` is rejected (the file is logged and skipped); a `---`
  anywhere else in the block, including inside an unquoted value, cuts the block short silently —
  everything after it becomes body text and `metadata` is lost. Never write `---` inside the block.
- `description` is read as a YAML scalar, not as raw text, so unquoted YAML punctuation changes
  its meaning: a ` #` (space, hash) starts a comment and silently drops the rest of the line; a
  leading `&` or `!` is read as an anchor or tag; a `: ` (colon, space) anywhere in the value, a
  tab, or a value that starts with `*`, `@`, `` ` ``, `[`, `{`, `|`, `>`, `%`, `,`, `- ` or `? `
  is not valid YAML at all. Double-quote a description that contains a colon or a `#`, or that
  starts with punctuation; a quoted string reads back verbatim. Every key needs a space after its
  colon (`name: x`, not `name:x`).
- A file whose block is not valid YAML, or whose `metadata` is not a mapping, is logged with its
  key and left out of that run's catalog rather than half-read; the other skills still load. When
  a saved skill does not show up in `skills_used`, the parser Lambda's CloudWatch log names the
  file and the YAML error.

A file with no block at all is not an error: it loads with an empty description and no `metadata`,
named after its folder.

## How the files reach S3

Terraform (`infra/modules/deal-pipeline`) seeds this directory into the assets bucket under the
layout in design §3. The bucket is `<name_prefix>-pipeline-assets-<account_id>` (e.g.
`recon-dev-pipeline-assets-...`), created when the recon root (`infra/environments/recon`) composes
the module behind `enable_deal_pipeline`:

```
skills/<name>/SKILL.md     ← skills/<name>/SKILL.md          (Lambda: SKILLS_PREFIX=skills/; BFF: PIPELINE_SKILLS_PREFIX)
prompts/parser-system.md   ← prompts/parser-system.md         (key PARSER_PROMPT_KEY)
prompts/assistant-system.md← prompts/assistant-system.md      (fixed key, no variable)
```

- The **parsing agent** loads `skills/` and `prompts/parser-system.md` from S3 at every run, so a
  change in S3 is live on the next parse with no redeploy.
- The **Skills tab** in the UI reads the same objects, lets an admin edit the parser prompt, and
  applies approved skill proposals by writing `skills/<name>/SKILL.md`. Approved proposals and
  UI edits change S3 only; they are **not** written back to this directory.
- **Skills and the parser prompt are seeded once, then owned by S3.** Their `aws_s3_object` seeds
  carry `ignore_changes`, so re-applying Terraform never re-uploads them and a learned skill is
  never reverted — which also means a rule you fix under `skills/` here does **not** reach a
  running environment on the next apply. It gets there either through the Skills tab or by
  forcing a reseed (`terraform taint` the object, or delete it in S3 and apply). The single owner
  of this rule, with the full attribute list, is the comment on `aws_s3_object.skill_seed` in
  `infra/modules/deal-pipeline/main.tf`.
- **`prompts/assistant-system.md` is the opposite.** It has no UI editor, so it tracks the repo: a
  committed change re-uploads on the next apply, and a hand edit made only in S3 is reverted by
  the next apply, even one that changes nothing else.
- The **assistant** proposes skill changes through the `skill_proposals` table and never writes
  S3 directly.

## Editing guidance

- The initial skills deliberately leave a handful of OMS rules unstated so the demo's learning
  loop has something to learn; the list is in `docs/deal-pipeline-design.md` §6. Do not "fix" the
  skills by adding those rules here — the demo shows the assistant proposing them.
- Every proper noun in these files is fictional and comes from `data/deal-emails` and
  `data/security-master`. Keep it that way: the repository is public.
- When you add a rule to `deal-parsing`, give it a place in the field-mapping table too, and
  check it against all seven emails in `data/deal-emails` — the worked example at the end of the
  skill is sample 01 and should still come out the same.

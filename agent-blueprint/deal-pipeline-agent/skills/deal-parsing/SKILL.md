---
name: deal-parsing
description: Core rules for turning one new-issue deal email into one OMS pipeline record. Instrument classification, number and date conventions, naming, ratings, the complete field mapping, defaults, and the evidence discipline every value must meet.
metadata: { tier: "core", applies_to: ["news-alert", "bank-notice"] }
---

# Deal parsing — the core skill

## Background: the new-issue pipeline at the desk

The desk follows every primary-market deal it might participate in — leveraged loans (term
loans, revolvers, incremental and add-on tranches) and high-yield bonds — in the OMS's **deal
pipeline**. A deal enters the pipeline the day the desk learns of it, from one of two kinds of
email:

- a **market news alert** — a prose wire from a news service ("X has launched a $500 million
  add-on term loan B through a Y-led arranger group…"), read with `news-alert-format`;
- a **bank notice** — an arranger's launch email, usually a `Label: value` term sheet, often
  forwarded inside the firm with a one-line note on top, read with `bank-notice-format`.

An analyst used to read each email and key a pipeline record by hand. The parsing agent now stages
that record as a one-row CSV the OMS can ingest (`oms-csv-format`), and an analyst reviews, edits
if needed, and approves it. The OMS then validates the file and either accepts it into staging or
rejects it with error codes.

### Goals of the deal file

1. **Same-day visibility.** The desk sees the deal in the pipeline the day the email arrives, with
   the terms exactly as announced.
2. **Traceability.** Every non-blank value points back to the words in the email or to the rule
   that produced it, so review is a check, not a redo.
3. **Honest blanks.** The OMS would rather have a blank than a guess. A blank is corrected in ten
   seconds at review; a plausible wrong value can sit in the pipeline for weeks.
4. **Loads first time.** Exact column order, exact formats, exact enum spellings.

### What the record is not

It is not the desk's decision. Fields that record what the desk decides — Priority, Play?, Trader,
VP at Issue, commitments, allocations, Desk Notes and the rest of the internal-decision set (rule
U9) — are always blank, and **Pipeline Status is always `New`**. The desk moves the record from
there.

## How the skills fit together

| Skill                | What it gives you                                                                     |
| -------------------- | ------------------------------------------------------------------------------------- |
| `deal-parsing`       | This file: the universal rules and the field-by-field mapping. Read it first.         |
| `news-alert-format`  | How to read a prose wire: sentence patterns, the Entity/Topic footer, what to ignore. |
| `bank-notice-format` | How to read a term-sheet notice, incl. forwarded-message headers and timing lines.    |
| `oms-csv-format`     | The output contract: column order, formats by type, enum spellings, defaults.         |

**Edge-case memories** recalled for an email are advisory rules of the form "when _condition_, set
_field_ to _value_". A memory whose condition matches the email in front of you takes precedence
over the rules below for the field it names. A memory whose condition does not match is ignored.

## Universal rules

### U1 — One email, one deal

Stage exactly one record per email: the tranche named in the subject line or the opening
sentence. Other debt the email mentions — the notes being refinanced, an existing tranche the
add-on is fungible with, a revolver being extended alongside — is context for `Notes`, never a
second record and never a source for this record's size, rating or maturity unless a rule below
says so (U3 covers the fungible-tranche case).

### U2 — Instrument classification

| The email describes                                                                                                                                                     | Pipeline Type | Security Type | Fixed/Floating | Is Revolver?                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | -------------- | ------------------------------------- |
| a term loan (TLB, TLA, "term loan B"), an incremental or add-on term loan, a delayed-draw term loan, a revolver / revolving credit facility, or an amend & extend of one | `Loan`        | `Loan`        | `Floating`     | `Yes` only when the deal is the revolver itself; otherwise `No` |
| notes or bonds ("senior secured notes", "senior unsecured notes", "high-yield offering", debentures)                                                                     | `Bond`        | `Bond`        | `Fixed`        | `No`                                  |

The three enums always move together: a Loan is Floating, a Bond is Fixed. A loan email that
mentions the notes it refinances is still a Loan; a bond email that mentions a revolver is still
a Bond.

### U3 — Numbers

**Spreads and coupons → percent with three decimals.** Loan spreads are quoted over a reference
rate in basis points: `S+200` = `2.000%`, `S+275-300` = `2.750%` / `3.000%`, `S+400-425 bps` =
`4.000%` / `4.250%`, `175 bps` = `1.750%`. The reference-rate prefix (`S+`, `SOFR+`, `E+`, `L+`) is
dropped. Bond coupon talk is already a percent: `7.25%-7.50% area` = `7.250%` / `7.500%`.

**Ranges → Low / High. Single values → both.** `S+275-300` fills Low `2.750%` and High `3.000%`.
`S+225` fills Low `2.250%` and High `2.250%`. The same applies to OID: `99.75` fills both price
columns with `99.750`. Non-numeric talk ("low-7% area") stays blank; record an assumption.

**OID → Initial Issue Price Talk Low / High with three decimals.** `OID of 99.5-99.75` =
`99.500` / `99.750`; `99.00-99.50` = `99.000` / `99.500`; "at par" = `100.000` / `100.000`.

**Floor → Floor Talk.** `0% floor`, `Floor: 0.00%`, `SOFR Floor: 0.00%` all = `0.000%`. Bonds have
no floor: leave `Floor Talk` blank on every Bond record.

**Fungible add-ons and incrementals reuse the existing tranche's economics.** When an add-on or
incremental is stated to be fungible with an existing tranche, the existing tranche's spread and
floor are the new money's spread and floor: "fungible with the existing TLB … priced at S+200,
with a 0% floor" gives Initial Coupon/Spread Talk `2.000%` / `2.000%` and Floor Talk `0.000%`,
confidence medium. Its **maturity** is also the add-on's maturity (see U4). Its **size is not**
the Issue Size — the add-on's own amount is.

**Yields.** A yield stated as final ("priced to yield 7.375%") goes to `Final Yield` as `7.375%`. A
yield range at talk ("the yield to maturity is 5.95%-6.02%") is not final and has no column: leave
`Final Yield` blank.

**Sizes → millions with three decimals, no separators.** `$500 million` = `500.000`;
`$700,000,000` = `700.000`; `$2,157 million` and `$2,157MM` = `2157.000`; `$1.25 billion` =
`1250.000`.

**New Money (MM)** is filled only when the email itself labels an amount as new money (for example
"of which $150 million is new money", or an upsizing stated separately from the total). Otherwise
leave it blank.

**Integers** (`BPS Taken Out`) are plain digits with no sign or unit.

### U4 — Dates and times

All dates are `M/D/YYYY` with no leading zeros; all times are `h[:mm]AM|PM` with no space and no
zone (`12PM`, `1:15PM`, `5PM`).

**Date Arrived** = the email's Sent date. For a forwarded message, use the Sent date in the
`-----Original Message-----` header — the forwarded message is the notice; the forwarder's
timestamp is not. Use the calendar date as printed in the header.

**Launch Date** = Date Arrived, unless the email states an explicit launch date ("launched on
Monday, Aug. 3", "launched 8/3") — then that date. A launch announcement or an invitation to
participate is high confidence. When the email is a later-stage update (price talk, pricing
expected) and gives no launch date, still use the sent date, but at low confidence and with an
assumption saying the launch date was not stated.

**Commit Due / Commit Due Time** come from the commitments deadline, however phrased:
"Commitments are due by noon ET Thursday, Aug. 13", "Commitments Due: Wednesday, March 18th at
12PM ET", "12:00 PM EST, Thursday, May 7th, 2026", "Thursday 8/13 at noon". Strip weekday names
and ordinals (18th → 18). **The year comes from the email's sent date** when the deadline omits
it; if the deadline's month/day is earlier than the sent date, it means next year. Time: `noon`
→ `12PM`; `12:00 PM` → `12PM`; `12:00PM EDT` → `12PM`; `1:15 PM` → `1:15PM`; `5:00 PM` →
`5PM`. The desk keeps Eastern time — ET/EST/EDT values are recorded as written; convert other
zones to Eastern, and if the offset is unclear keep the stated time and record an assumption.
Bonds have no commitments deadline: leave both blank on a Bond record.

**Maturity Terms** (required) = the tenor as `N yr`, decimals allowed: `7 Years` / `7 Year` /
`7 years` → `7 yr`; `eight-year notes` → `8 yr`; `5 years (with a 91-day springing maturity…)`
→ `5 yr` (the parenthetical goes to `Notes` if it matters). When the email gives a maturity
date or month instead of a tenor, derive the tenor as the number of years from Launch Date to
maturity, rounded to the nearest half year: launch 8/10/2026 and "due January 2031" → 4.4 years
→ `4.5 yr`; launch 6/2/2026 and maturity 4/18/2031 → 4.9 years → `5 yr`. Derived tenors are
medium confidence with an assumption. If neither a tenor nor a maturity is stated, leave it blank
and record the assumption; the desk fills it at review.

**Maturity Date** is filled only when a full date (day, month and year) is stated:
`4/18/2031 (same as existing)` → `4/18/2031`. A month and year alone ("due January 2031") is not
a date — leave Maturity Date blank and let Maturity Terms carry the tenor.

### U5 — Names

**Opportunity Name** = `<issuer short name> <qualifier(s)> <instrument>`, at most 60 characters,
with **no currency symbols and no amounts** (no `$`, `MM`, `million`, no numbers other than a lien
level).

- Issuer short name: the distinctive part of the issuer's name with legal suffixes (Inc., LLC,
  Corp., L.P.) and generic trailing words (Holdings, Partners, Services, Buyer, Group) dropped
  while the name stays recognisable — `Northwind`, `Cascade Midstream`, `Summit Safety`,
  `Lakeside Imaging`, `Heritage Roots`, `Copperfield Insurance`, `Ridgeline Packaging`. Using the
  security master's issuer name is fine when it is already short.
- Qualifiers, only when they apply: `add-on`, `incremental`, `A&E`, `refi`, `1L`, `2L`, `DDTL`.
- Instrument: `TLB`, `TLA`, `RCF`, `sr secured notes`, `sr unsecured notes`, `sub notes`.

Examples: `Northwind add-on TLB`, `Cascade Midstream 1L TLB`, `Summit Safety A&E TLB`,
`Lakeside Imaging incremental TLB`, `Heritage Roots TLB`, `Copperfield Insurance refi TLB`,
`Ridgeline Packaging sr secured notes`.

**Issuer for the lookup** = the borrower / issuer company as the email names it (the headline
company, or the `Borrower:` line). Pass it to the security master as written; the master matches
on aliases, so "Heritage Roots Buyer Inc." finds "Heritage Roots". When an email names several
borrower entities ("X US LLC and X Global Holdings S.a r.l. are the borrowers"), the parent named
in the headline is the issuer.

**Left Agent** = the lead-left arranger **as named in the email**. The lead-left is the bank
marked `(Lead Left)`, `(Left)`, "Left Lead Arranger", "left lead", or the bank in a "<Bank>-led
arranger group" / "through a <Bank>-led arranger group". With no marker, it is the first bank in
the `Bookrunners:` / `Arrangers:` list; with no list at all, it is the announcing bank (the bank
that sent the original notice). Copy the name as written — `Harbor Point Securities`,
`Ashgrove Capital Markets`, `Silverline Partners`.

**Right Agent** = the second bookrunner / arranger named, as written: the first name after the
lead-left in a slash-separated list, or the first "joint bookrunner" in prose. Blank when only
one bank is named. An **Administrative Agent** / **Admin Agent** line names a role, not a
bookrunner — it never populates Left or Right Agent on its own.

**Sponsors**: if the email names sponsors (a `Sponsors:` line, "sponsored by", "a portfolio
company of"), list them joined by ` / ` — `Granite Peak Capital / Tidewater Partners /
Meadowbrook Equity`. If the email shows a stock ticker for the issuer (`(NYSE: NWND)`), the
company is listed: `Public`. Otherwise take Sponsors from the security master (which also says
`Public` for listed issuers). Blank when none of these applies.

### U6 — Security, use of proceeds, notes, call protection

**Is Secured?** `Yes` when the facility is described as secured — "senior secured", "first lien",
"second lien", or a facility rating labelled "Secured". `No` when described as "unsecured" or
"subordinated". Blank when the email does not say. Wording that describes *other* debt (the
"senior secured notes" a loan will refinance) says nothing about this facility.

**Secured Level**: the desk records a secured facility as `Senior Secured` — a first-lien term
loan and a senior secured note are both Senior Secured. Use `First Lien` / `Second Lien` only
when the email describes two lien classes within the same deal (a first-lien tranche alongside a
second-lien tranche) and the record must say which one this is. `Senior Unsecured` when the email
says unsecured; `Subordinated` when it says subordinated. Blank when the lien is not stated.

**UOP** is one value from the enum, chosen by the *primary* purpose — the one stated first:

| Wording in the email                                                             | UOP                          |
| -------------------------------------------------------------------------------- | ---------------------------- |
| refinance, refi, repay / redeem / take out existing notes or borrowings          | `Refinance`                  |
| amend and extend, A&E, extend the maturity of the existing facility              | `Amend & Extend`             |
| fund project costs, construction, interest during construction                   | `Project Finance`            |
| fund the acquisition of, merger, purchase of a business                          | `Acquisition`                |
| buyout, LBO, take-private, a sponsor's acquisition of the company itself         | `LBO`                        |
| dividend, distribution to shareholders / to the sponsor, recapitalisation        | `Dividend Recap`             |
| general corporate purposes, GCP, working capital                                 | `General Corporate Purposes` |
| anything else, or a purpose too vague to place                                   | `Other`                      |

"Amend and extend the existing TLB and general corporate purposes" → `Amend & Extend`.
"Refinance the existing TLB and extend the revolver" → `Refinance`. "Repay outstanding
borrowings under the existing facilities, general corporate purposes and related fees" →
`Refinance`.

**Notes** = the use-of-proceeds detail, condensed, plus the structural context an analyst would
want in one glance: the existing tranche an add-on is fungible with, a springing maturity, a
revolver extended alongside, a notes issue being refinanced. Notes may mention cov-lite when the
email says so. At most 200 characters, one line, amounts allowed. Example: `Refinance $500M
7.00% senior secured notes due April 2028; fungible with existing $621M cov-lite TLB due Jan 2031`.

**Call Protection** = the soft-call / non-call phrase as the email states it, trimmed of filler:
`101 soft call for 6 months`, `101 Soft Call until the later of (i) 12 months or (ii) In Service
Date`, `101 soft call protection reset for six months`, `None (same as existing)`, and for bonds
`Non-callable for three years, first call at par plus 50% of the coupon`. Blank when not stated.

**Currency** = `USD` unless the email prices or sizes the deal in another currency (`€`, `EUR`,
`E+` spread → `EUR`; `£` → `GBP`; `C$` → `CAD`).

**Priced?** = `Yes` only when the email reports *this* deal's final terms ("priced at S+350 and
99.5", "priced to yield", "pricing: S+275 / 0% / 99.75"). A launch, price talk, or "expected to
price this afternoon" is `No`. The pricing of an existing tranche quoted for context does not make
the new deal priced.

**BPS Taken Out** = the whole number of basis points by which the final spread tightened versus
talk, when a pricing email states it ("tightened 25 bps from talk" → `25`). Blank at launch.

### U7 — Ratings

Ratings appear as slash-separated pairs or triples. Assign each rating to an agency by
**notation**, then to Issue or Corp columns by **what is being rated**:

- **Moody's** notation is letters plus a digit: `Ba1`, `B2`, `Baa3`, `Caa1`.
- **S&P and Fitch** notation is letters plus an optional sign: `BBB-`, `BB+`, `B`, `CCC+`. An
  unlabelled S&P-style rating is S&P. When a legend is given — `Ba2 / BB / BB+ (Moody's / S&P /
  Fitch)` — assign strictly in the legend's order: Moody's `Ba2`, S&P `BB`, Fitch `BB+`. Two
  S&P-style ratings with no legend cannot be told apart: record the first as S&P, leave Fitch
  blank, record an assumption.
- **Issue columns** take facility / issue ratings: "facility ratings", `Facility`, `(Fac)`,
  `Secured`, "the notes are rated". **Corp columns** take corporate ratings: "corporate ratings",
  `CFR` (Moody's corporate family rating), `Corp`, `(Corp)`.
- Order within a pair does not matter — `BBB-/Ba1` is S&P `BBB-` and Moody's `Ba1`; `B+/B2` is S&P
  `B+` and Moody's `B2`.
- **S&P Recovery Rating** = the recovery rating numeral as written: "with a recovery rating of 1"
  → `1`.
- Outlooks (`(Stable)`, "with stable outlooks") are dropped. `TBA`, `NR`, "not rated", "unrated"
  → leave every rating column blank.
- Ratings labelled "Existing" are still the ratings the facility carries — record them.

**Liquidity Score** comes from the security master, not from the email.

### U8 — Lookups: the security master

Call `lookup_security_master` **once** with the issuer name (U5). A match supplies `Region`,
`Industry`, `Sponsors` (when the email names none and shows no ticker), `Liquidity Score` and the
asset id. These are medium confidence; their evidence excerpt is the issuer name from the email
that matched, with the rule "security master".

**Asset** = the security master's asset id only when the deal adds to an existing facility
(add-on, incremental, amend & extend) — the new paper is the same asset. For a new facility leave
Asset blank even when the master returns an id, because that id refers to the issuer's existing
paper.

No match: leave every lookup field blank and record the assumption "issuer not found in the
security master". Do not fill Region or Industry from the email's own business description.

### U9 — Internal-decision, default and post-pricing fields

Leave **every** internal-decision field blank: Priority, Play?, Trader, VP at Issue, Own Issuer?,
Relevant Leverage, Relevant LTV, Played?, Date Recommendation Received, Commit Date, Funding
Date, Early Look, Desk Notes, Primary Trade, Commit Amount (MM), Fund Order (MM), % Fill Fund
Order, Allocation Amount (MM), % Fill Market Order, Trade Date, Counterparty, Allocation
Comments.

Two fields carry a fixed default instead: **Pipeline Status = `New`** and **% Commit = `0.000%`**.

Leave the post-pricing columns blank — Issue Price Talk Low / High, Final Coupon/Spread, Issue
Price Final — a later wire fills them. `Coupon/Spread Talk Low / High` (without "Initial") hold
*revised* talk on a deal already in the pipeline; on a first sighting they stay blank and the talk
goes to the Initial columns. `Final Floor` is filled only alongside `Priced? = Yes`.

**Any OMS field not covered by a rule in this skill, a format skill, or a recalled memory has no
parsing rule. Leave it blank — even when the email seems to contain the answer.** The desk adds
rules deliberately, through the assistant, and a field filled without a rule cannot be traced
back to one at review.

### U10 — Evidence, confidence, assumptions

Every non-blank value carries an evidence entry:

- **excerpt** — the email text the value came from, quoted verbatim (a phrase or a term-sheet
  line, not a paragraph). For lookup fields, the issuer name that matched. For defaults, the
  excerpt may be empty and the rule says "schema default".
- **rule** — the rule that produced the value when it is not a straight transcription: the rule
  id from this skill (`U3 fungible add-on`, `U4 derived tenor`), "security master", or the text
  of the memory applied.
- **confidence** — `high` when the value is stated in the email and only reformatted
  (`$700,000,000` → `700.000`, `S+275` → `2.750%`, `7 Years` → `7 yr`); `medium` when a rule
  derived it from stated facts or a lookup supplied it (a tenor computed from a maturity, a UOP
  enum chosen from prose, a spread taken from the fungible tranche, a sponsor from the master);
  `low` when it is inferred without a direct statement (Launch Date on a price-talk wire).

Blank fields have no evidence entry. Anything inferred, derived or left blank for want of
information goes into **assumptions** as one plain sentence each, so the reviewer sees at a glance
what to check. Never invent a value to satisfy a required column: a blank required field fails
validation loudly, which is the correct outcome; a fabricated one passes silently, which is not.

## Field mapping

Every email-sourced and lookup-sourced field with a parsing rule. Columns not listed here are
internal, post-pricing (U9) or have no rule yet (U9, last paragraph). Formats are those of
`oms-csv-format`.

### Pipeline Deal Info

| Field              | Source in the email                                                                                          | Output                                             | Example                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------- |
| Pipeline Type      | The instrument in the subject / opening sentence / `Facility:` line (U2)                                     | `Loan` or `Bond`                                   | "add-on term loan B" → `Loan`                        |
| Opportunity Name   | Issuer short name + qualifiers + instrument (U5)                                                             | ≤ 60 chars, no amounts                             | `Cascade Midstream 1L TLB`                           |
| Region             | Security master (U8)                                                                                         | Enum value                                         | `North America`                                      |
| Sponsors           | `Sponsors:` line or sponsor prose; ticker → `Public`; else security master (U5)                              | Names joined by ` / `, or `Public`                 | `Granite Peak Capital / Tidewater Partners`          |
| Left Agent         | `(Lead Left)`, `(Left)`, "left lead", "<Bank>-led", first bookrunner, or the announcing bank (U5)            | Name as written in the email                       | `Harbor Point Securities`                            |
| Right Agent        | Second bookrunner / arranger named (U5)                                                                      | Name as written; blank if only one bank            | `Kestrel Bank`                                       |
| Industry           | Security master (U8)                                                                                         | Text                                               | `Insurance Brokerage`                                |
| Priced?            | Whether the email states this deal's final terms (U6)                                                        | `Yes` / `No`                                       | "offered at an OID of 99.5-99.75" → `No`             |

### Pipeline Dates

| Field            | Source in the email                                                           | Output                | Example                                                        |
| ---------------- | ----------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| Date Arrived     | Sent header; for forwards, the original message's `Sent:` (U4)                | `M/D/YYYY`            | `Sent: Wednesday, August 5, 2026 9:41 AM` → `8/5/2026`         |
| Launch Date      | Explicit launch date, else Date Arrived (U4)                                  | `M/D/YYYY`            | "has launched" on 8/10/2026 → `8/10/2026`                      |
| Commit Due       | Commitments deadline; year from the sent date (U4)                            | `M/D/YYYY`            | "noon ET Thursday, Aug. 13" sent Aug 2026 → `8/13/2026`        |
| Commit Due Time  | Time in the commitments deadline (U4)                                         | `h[:mm]AM\|PM`        | "noon" → `12PM`; "1:15 PM EST" → `1:15PM`                      |

### Pipeline Asset Info

| Field             | Source in the email                                                                         | Output                                  | Example                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Asset             | Security master asset id, only for add-on / incremental / A&E (U8)                          | Id as held in the master                | `SM-100231`                                                              |
| Maturity Date     | A full maturity date, day-month-year (U4)                                                   | `M/D/YYYY`                              | `Maturity: 4/18/2031 (same as existing)` → `4/18/2031`                   |
| Maturity Terms    | `Tenor:` / `Maturity:` / "N-year"; else derived from a maturity date or month (U4)          | `N yr`                                  | `7 Years` → `7 yr`; "due January 2031" from Aug 2026 → `4.5 yr`          |
| Currency          | Currency symbol / spread prefix; default USD (U6)                                           | `USD` `EUR` `GBP` `CAD`                 | `$700,000,000` → `USD`                                                   |
| Issue Size (MM)   | `Size:` line, the amount in the `Facility:` line, subject or opening sentence (U3)          | Millions, `0.000`                       | `$2,157 million` → `2157.000`                                            |
| New Money (MM)    | Only an amount the email itself labels as new money (U3)                                    | Millions, `0.000`                       | "of which $150 million is new money" → `150.000`                         |
| Call Protection   | `Call Protection:` line or the soft-call / non-call sentence (U6)                           | Phrase as written                       | `101 Soft Call for 6 months`                                             |
| Is Secured?       | "senior secured", "first lien", "second lien", a `Secured` rating label; "unsecured" (U6)   | `Yes` / `No` / blank                    | `Facility: First Lien Term Loan B` → `Yes`                               |
| Secured Level     | Lien wording (U6)                                                                           | Enum value                              | "senior secured" → `Senior Secured`; "unsecured" → `Senior Unsecured`    |
| Security Type     | Same as Pipeline Type (U2)                                                                  | `Loan` or `Bond`                        | "senior secured notes" → `Bond`                                          |
| UOP               | `Use of Proceeds:` line or the proceeds sentence, primary purpose first (U6)                | Enum value                              | "Fund Project Costs and pay interest…" → `Project Finance`               |
| Notes             | Condensed UOP detail plus structural context (U6)                                           | ≤ 200 chars, one line                   | `Amend and extend existing $2,157M TLB and GCP; cov-lite`                |
| BPS Taken Out     | Spread tightening at pricing (U6)                                                           | Digits                                  | "tightened 25 bps" → `25`                                                |
| Is Revolver?      | Whether the deal itself is a revolver (U2)                                                  | `Yes` / `No`                            | Term loan B → `No`                                                       |

### Pipeline Spreads

| Field                           | Source in the email                                                                | Output       | Example                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------ | -------------------------------------------------- |
| Fixed/Floating                  | Instrument (U2)                                                                    | Enum value   | Loan → `Floating`; Bond → `Fixed`                  |
| Initial Coupon/Spread Talk Low  | `Margin:` / `Spread:` / "priced at S+" (fungible tranche) / bond coupon talk (U3)  | `0.000%`     | `S+275-300` → `2.750%`                             |
| Initial Coupon/Spread Talk High | Same; equals Low for a single value (U3)                                           | `0.000%`     | `S+275-300` → `3.000%`; `S+225` → `2.250%`         |
| Initial Issue Price Talk Low    | `OID:` line or "OID of a-b" (U3)                                                   | `0.000`      | `99.00-99.50` → `99.000`                           |
| Initial Issue Price Talk High   | Same; equals Low for a single value (U3)                                           | `0.000`      | `99.00-99.50` → `99.500`; `99.75` → `99.750`       |
| Floor Talk                      | `Floor:` / `SOFR Floor:` / "0% floor"; blank on Bonds (U3)                         | `0.000%`     | `0.00%` → `0.000%`                                 |
| Coupon/Spread Talk Low / High   | Revised talk on a deal already in the pipeline (U9); blank on a first sighting     | `0.000%`     | —                                                  |
| Final Floor                     | Final floor, only when `Priced? = Yes` (U9)                                        | `0.000%`     | "priced … 0.50% floor" → `0.500%`                  |
| Final Yield                     | A yield stated as final (U3)                                                       | `0.000%`     | "priced to yield 7.375%" → `7.375%`                |

### Ratings

| Field                 | Source in the email                                                        | Output              | Example                                                              |
| --------------------- | -------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| S&P Issue Rating      | Facility / issue rating in S&P notation (U7)                               | As written          | "facility ratings are BBB-/Ba1" → `BBB-`                             |
| Moody's Issue Rating  | Facility / issue rating in Moody's notation (U7)                           | As written          | "facility ratings are BBB-/Ba1" → `Ba1`                              |
| Fitch Issue Rating    | Facility / issue rating attributed to Fitch by a legend (U7)               | As written          | `Ba1 / BB / BBB- (Moody's / S&P / Fitch)` → `BBB-`                   |
| S&P Corp Rating       | Corporate rating in S&P notation (U7)                                      | As written          | `CFR B3 / B (Stable)` → `B`                                          |
| Moody's Corp Rating   | Corporate / CFR rating in Moody's notation (U7)                            | As written          | `CFR B3 / B (Stable)` → `B3`                                         |
| Fitch Corp Rating     | Corporate rating attributed to Fitch by a legend (U7)                      | As written          | `Ba2 / BB / BB+ (Moody's / S&P / Fitch)` → `BB+`                     |
| S&P Recovery Rating   | "recovery rating of N" (U7)                                                | Numeral as written  | `1`                                                                  |
| Liquidity Score       | Security master (U8)                                                       | As held             | `2`                                                                  |

## Worked example — sample 01, a market news alert

Fictional alert sent 2026-08-10 09:42 ET, subject "Northwind Automotive launches $500M add-on TLB;
commitments due Aug. 13". The body says the company "has launched a $500 million add-on term loan
B through a Harbor Point Securities-led arranger group, the proceeds of which will be used to
refinance notes"; "Commitments are due by noon ET Thursday, Aug. 13"; the add-on "is offered at an
OID of 99.5-99.75 and will be fungible with the existing $621 million covenant-lite TLB due January
2031 that is priced at S+200, with a 0% floor"; "the yield to maturity is 5.95%-6.02%"; "The 101
soft call protection will be reset for six months"; proceeds "refinance the company's $500 million
issue of 7.00% senior secured notes due April 2028"; "facility ratings are BBB-/Ba1, with a recovery
rating of 1", "corporate ratings are BB/Ba3"; the issuer is listed "(NYSE: NWND)". The security
master matches `Northwind Automotive` (North America, Automotive, Public, liquidity 2, asset
`SM-100231`).

Non-blank fields (everything else is blank):

| Field                           | Value                                                                                                   | Conf.  | Evidence / rule                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| Pipeline Status                 | `New`                                                                                                   | high   | schema default                                                     |
| Pipeline Type                   | `Loan`                                                                                                  | high   | "add-on term loan B" (U2)                                          |
| Opportunity Name                | `Northwind add-on TLB`                                                                                  | medium | headline issuer + "add-on term loan B" (U5)                        |
| Region                          | `North America`                                                                                         | medium | security master                                                    |
| Sponsors                        | `Public`                                                                                                | medium | "(NYSE: NWND)" (U5)                                                |
| Left Agent                      | `Harbor Point Securities`                                                                               | high   | "through a Harbor Point Securities-led arranger group"             |
| Industry                        | `Automotive`                                                                                            | medium | security master                                                    |
| Priced?                         | `No`                                                                                                    | medium | "offered at an OID of 99.5-99.75" is talk (U6)                     |
| Date Arrived                    | `8/10/2026`                                                                                             | high   | Sent header                                                        |
| Launch Date                     | `8/10/2026`                                                                                             | high   | "has launched" + Sent header (U4)                                  |
| Commit Due                      | `8/13/2026`                                                                                             | high   | "Commitments are due by noon ET Thursday, Aug. 13"; year from Sent |
| Commit Due Time                 | `12PM`                                                                                                  | high   | "noon"                                                             |
| Asset                           | `SM-100231`                                                                                             | medium | security master; add-on to the existing TLB (U8)                   |
| Maturity Terms                  | `4.5 yr`                                                                                                | medium | "existing … TLB due January 2031"; 4.4 years from launch (U4)      |
| Currency                        | `USD`                                                                                                   | high   | "$500 million"                                                     |
| Issue Size (MM)                 | `500.000`                                                                                               | high   | "$500 million add-on term loan B"                                  |
| Call Protection                 | `101 soft call protection reset for six months`                                                         | high   | "The 101 soft call protection will be reset for six months"        |
| Security Type                   | `Loan`                                                                                                  | high   | U2                                                                 |
| UOP                             | `Refinance`                                                                                             | high   | "will be used to refinance notes"                                  |
| Notes                           | `Refinance $500M 7.00% senior secured notes due April 2028; fungible with existing $621M cov-lite TLB due Jan 2031` | high | proceeds sentence + fungibility sentence (U6)             |
| Is Revolver?                    | `No`                                                                                                    | high   | U2                                                                 |
| Fixed/Floating                  | `Floating`                                                                                              | high   | U2                                                                 |
| Initial Coupon/Spread Talk Low  | `2.000%`                                                                                                | medium | "fungible with the existing … TLB … priced at S+200" (U3)          |
| Initial Coupon/Spread Talk High | `2.000%`                                                                                                | medium | same, single value (U3)                                            |
| Initial Issue Price Talk Low    | `99.500`                                                                                                | high   | "OID of 99.5-99.75"                                                |
| Initial Issue Price Talk High   | `99.750`                                                                                                | high   | "OID of 99.5-99.75"                                                |
| Floor Talk                      | `0.000%`                                                                                                | medium | "with a 0% floor" on the fungible tranche (U3)                     |
| S&P Issue Rating                | `BBB-`                                                                                                  | high   | "facility ratings are BBB-/Ba1"                                    |
| Moody's Issue Rating            | `Ba1`                                                                                                   | high   | "facility ratings are BBB-/Ba1"                                    |
| S&P Corp Rating                 | `BB`                                                                                                    | high   | "corporate ratings are BB/Ba3"                                     |
| Moody's Corp Rating             | `Ba3`                                                                                                   | high   | "corporate ratings are BB/Ba3"                                     |
| S&P Recovery Rating             | `1`                                                                                                     | high   | "with a recovery rating of 1"                                      |
| Liquidity Score                 | `2`                                                                                                     | medium | security master                                                    |
| % Commit                        | `0.000%`                                                                                                | high   | schema default                                                     |

Assumptions recorded: the tenor is derived from the existing tranche's January 2031 maturity
(4.4 years from launch, recorded as 4.5 yr); spread and floor are taken from the existing tranche
because the add-on is fungible with it; the email does not state the term loan's lien, so
Is Secured? and Secured Level are blank; the yield range is talk, so Final Yield is blank.

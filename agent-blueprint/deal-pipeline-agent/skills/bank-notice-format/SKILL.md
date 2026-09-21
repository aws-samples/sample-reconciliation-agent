---
name: bank-notice-format
description: How to read an arranger's launch notice. Term-sheet label mapping, forwarded-message headers, lead-left markers, administrative agent versus bookrunners, TBA ratings, and the timing lines that carry the commitments deadline.
metadata: { tier: "format", applies_to: ["bank-notice"] }
---

# Reading a bank notice

A bank notice is the arranger's own launch email: an announcement sentence, a `Label: value` term
sheet, a timing block, and a footer of logistics and disclaimers. It often reaches the desk
**forwarded** by someone inside the firm with a one-line note on top. This skill says how to read
each part and which `deal-parsing` field it feeds; conversions and formats are in `deal-parsing`.

## Forwarded messages

A subject starting `FW:` and a body containing `-----Original Message-----` is a forward. Treat
the two layers differently:

- **The forwarder** (the firm's own desk: "Forwarding the Blue Ridge launch below. Lender call is
  tomorrow at 1pm.") is **not a counterparty**. Their address never becomes Left or Right Agent,
  and their timestamp is not Date Arrived. Their note may corroborate timing ("Refi officially
  launched today", "commitments due Thursday the 13th at noon") and can be cited as evidence when
  the term sheet is silent, but the term sheet wins on any conflict.
- **The original message header** carries the arranger and the date:

  ```
  From: Syndicated Finance <syndicate@silverlinepartners.example>
  Sent: Wednesday, August 5, 2026 9:41 AM
  Subject: Copperfield Insurance Partners - $1,295MM Term Loan B Refinancing - Launch
  ```

  `Sent:` here is **Date Arrived** (`8/5/2026`) and, for a launch, **Launch Date**. The bank the
  original `From:` belongs to is **the announcing bank** — the Left Agent when the term sheet has
  no arranger line, and a cross-check on the arranger line when it does.

A notice sent straight to the desk has no inner header: use the email's own Sent header and
sender.

## The announcement sentence

"**Ashgrove Capital Markets** is pleased to announce the launch of the **$700,000,000 First Lien
Term Loan B** for **Cascade Midstream Partners, LLC**." — announcing bank, size, facility,
borrower, and the fact that this is a launch (Launch Date = sent date, `high`). Variants:

- "**Harbor Point Securities, as Left Lead Arranger**, is pleased to announce…" — the left-lead
  marker can sit here rather than on the arranger line.
- "**Silverline Partners, on behalf of the arranger group**, is pleased to announce…" — read with
  an `Arrangers: Silverline Partners-led arranger group` line, the announcing bank is the lead-left.
- "**Kestrel Bank** is pleased to **invite you to participate in the Amend & Extend** of the Senior
  Secured Term Loan B…" — an A&E invitation is the launch of the A&E.

## Term-sheet labels

Labels vary from bank to bank; match on meaning. Each `Label: value` line is a self-contained
evidence excerpt — quote the whole line.

| Label(s) seen                                                            | Feeds                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Borrower:`                                                              | Issuer for the security master lookup and the Opportunity Name (U5).                                                                                                                                                              |
| `Facility:`                                                              | Instrument → Pipeline Type, Security Type, Fixed/Floating (U2); qualifiers for the Opportunity Name (`First Lien` → `1L`, `Fungible Incremental` → `incremental`, `Amend & Extend` → `A&E`); lien wording → Is Secured? / Secured Level (U6); an embedded amount (`$200MM Fungible Incremental Term Loan B`) → Issue Size when there is no `Size:` line. |
| `Size:`                                                                  | Issue Size (MM): `$700,000,000` → `700.000`; `$2,157 million` → `2157.000`.                                                                                                                                                       |
| `Tenor:` / `Maturity:`                                                   | `7 Years`, `7 Year`, `5 years (…)` → Maturity Terms `7 yr` / `5 yr`. A full date (`4/18/2031 (same as existing)`) → Maturity Date `4/18/2031` **and** Maturity Terms derived from the launch date (U4).                             |
| `Margin:` / `Spread:` / `Pricing:`                                       | Initial Coupon/Spread Talk Low / High: `S+275-300` → `2.750%` / `3.000%`; `S+175 bps` → `1.750%` / `1.750%`; `S+400-425 bps` → `4.000%` / `4.250%`.                                                                              |
| `Floor:` / `SOFR Floor:`                                                 | Floor Talk: `0.00%`, `0.00% (same as existing)` → `0.000%`.                                                                                                                                                                       |
| `OID:`                                                                   | Initial Issue Price Talk Low / High: `99.00-99.50` → `99.000` / `99.500`; `99.50 - 99.75` → `99.500` / `99.750`; `99.75` → `99.750` / `99.750`.                                                                                  |
| `Call Protection:` / `Soft Call:`                                        | Call Protection, phrase as written: `101 Soft Call until the later of (i) 12 months or (ii) In Service Date`, `101 soft call for 6 months`, `None (same as existing)`.                                                              |
| `Use of Proceeds:`                                                       | UOP enum by primary purpose (U6) and the condensed detail in Notes.                                                                                                                                                               |
| `Ratings:` / `Existing Ratings:` / `Existing Ratings (Corp):` / `(Fac):` | Ratings columns by notation and legend (U7). `Ratings: TBA` → every rating column blank. `CFR B1 / B+; Facility Ba3 / B+` → Moody's Corp `B1`, S&P Corp `B+`, Moody's Issue `Ba3`, S&P Issue `B+`. `CFR B3 / B (Stable); Secured B3 / B` → Corp `B3` / `B`, Issue `B3` / `B`; the `Secured` label also makes Is Secured? `Yes`. |
| `Bookrunners:` / `Arrangers:` / `Joint Lead Arrangers:`                  | Left Agent and Right Agent, names as written (U5). See "Lead-left markers" below.                                                                                                                                                  |
| `Administrative Agent:` / `Admin Agent:`                                 | A role, not a bookrunner. Does not populate Left or Right Agent. (When it is the only bank in the notice, that bank is the announcing bank and is Left Agent for that reason, not this one.)                                        |
| `Sponsors:` / `Sponsor:`                                                 | Sponsors, joined by ` / `: `Granite Peak Capital, Tidewater Partners, Meadowbrook Equity` → `Granite Peak Capital / Tidewater Partners / Meadowbrook Equity`.                                                                       |
| `Financial Covenant:` / `Financial Covenants:`                           | Notes may mention cov-lite when the line says so (`Cov-Lite`, `None (same as existing, cov-lite)`).                                                                                                                                |
| `Business:` / `Sector:`                                                  | Context only. Industry and Region come from the security master (U8).                                                                                                                                                             |
| `Amortization:` `ECF Sweep:` `Guarantors:` `Security:` `Negative Covenants:` | Not OMS fields. Ignore. (A `Security:` line describing collateral corroborates a `Senior Secured` facility but is not needed to set it.)                                                                                       |
| `Currency:`                                                              | Currency; absent → `USD` unless the amounts say otherwise (U6).                                                                                                                                                                   |

## Lead-left markers

Read the arranger line left to right:

| Line                                                                                                                                                | Left Agent                  | Right Agent            |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------- |
| `Bookrunners: Ashgrove Capital Markets (Lead Left) / Kestrel Bank / Blue Ridge Financial`                                                           | `Ashgrove Capital Markets`  | `Kestrel Bank`         |
| `Arrangers: Harbor Point Securities (Left) / Blue Ridge Financial / Northgate Markets / Kestrel Bank / …`                                           | `Harbor Point Securities`   | `Blue Ridge Financial` |
| `Arrangers: Kestrel Bank`                                                                                                                           | `Kestrel Bank`              | blank                  |
| `Arrangers: Silverline Partners-led arranger group`                                                                                                 | `Silverline Partners`       | blank                  |
| no arranger line; `Admin Agent: Blue Ridge Financial`; announced by Blue Ridge Financial                                                            | `Blue Ridge Financial`      | blank                  |

The marker (`(Lead Left)`, `(Left)`, `-led`, "as Left Lead Arranger" in the announcement) beats
list position. Without a marker the first name is left. Names are copied as written, including
suffixes like `Securities`, `Capital Markets`, `Financial`, `Partners`, `& Co.`. Any bank after the
second is not recorded.

## Timing lines

```
Lender Conference Call: Wednesday, March 11, 2026 at 4:00PM ET
Dial-in: +1 (555) 010-0142, Access Code 884 201
Commitments Due: Wednesday, March 18th at 12PM ET
```

Only the **commitments** line feeds a field. The shapes seen, and the Commit Due / Commit Due
Time they produce (year from the Sent header when omitted; weekday and ordinal dropped; U4):

| Line                                                        | Commit Due   | Commit Due Time |
| ----------------------------------------------------------- | ------------ | --------------- |
| `Commitments Due: Wednesday, March 18th at 12PM ET`         | `3/18/2026`  | `12PM`          |
| `Commitments Due: 12:00 PM EST, Thursday, May 7th, 2026`    | `5/7/2026`   | `12PM`          |
| `Commitments Due: Friday, June 5th at 12:00PM EDT`          | `6/5/2026`   | `12PM`          |
| `Commitments Due: Tuesday, July 28th at 12:00 PM ET`        | `7/28/2026`  | `12PM`          |
| `Commitments Due: Thursday 8/13 at noon`                    | `8/13/2026`  | `12PM`          |
| `Commitments Due: Monday, May 4th, 2026 at 5:00 PM ET`      | `5/4/2026`   | `5PM`           |

`Lender Call` / `Lender Conference Call` lines are logistics, not OMS fields; a forwarder's
"lender call is tomorrow" is likewise noise. Time zones `ET`, `EST`, `EDT` are the desk's own and
are dropped; other zones are converted to Eastern (U4).

## Noise

Ignore, and do not quote as evidence: `Dial-in:` numbers, `Access Code` / `Passcode`, deal-site
URLs ("Materials are on the deal site", "https://…"), "Please contact your … salesperson",
public-side / private-side notices, confidentiality and "not an offer to sell" disclaimers, and
the bank's signature block.

## Checklist before staging

- Forward or direct? Date Arrived from the inner `Sent:` on a forward.
- Borrower looked up once, from the `Borrower:` line as written.
- Arranger line read left to right; marker beats position; Admin Agent ignored for Left / Right.
- Every `Label: value` line you used is quoted whole as its excerpt.
- `Ratings: TBA` left every rating column blank.
- Commitments deadline year taken from the Sent header.

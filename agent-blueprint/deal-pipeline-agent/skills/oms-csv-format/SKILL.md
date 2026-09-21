---
name: oms-csv-format
description: The OMS staging CSV contract. Column order, the exact format for each value type, enum spellings, defaults, blanks and quoting. One header row and one data row per deal.
metadata: { tier: "reference", applies_to: ["news-alert", "bank-notice"] }
---

# The OMS staging CSV

The OMS ingests one CSV per deal. It checks the header against its schema, every value against
its type, and then its own business rules, and it rejects the file with the full list of errors
it found, each with a stable code and a hint. This skill is the contract for the first two checks:
**what the columns are, in what order, and what a value of each type looks like.** The schema
itself is `backend/deal_pipeline/oms_fields.json`; the column order below is that file's array
order.

## Shape

- Two lines: a **header row** of the 74 labels below, in order, then **one data row**. Never more
  than one deal per file.
- `\n` line endings. RFC 4180 quoting: a value containing a comma, a double quote or a line break
  is wrapped in double quotes, with embedded quotes doubled. Nothing else is quoted.
- A **blank** is an empty cell (two adjacent commas). Never `N/A`, `-`, `TBD`, `null` or a space.
- No thousands separators, no leading zeros in dates, no spaces inside numbers or times, no
  trailing spaces.

## Formats by type

| Type      | Format                                              | Valid                            | Invalid                                 |
| --------- | --------------------------------------------------- | -------------------------------- | --------------------------------------- |
| `date`    | `M/D/YYYY`, no leading zeros                        | `8/13/2026`, `12/1/2026`         | `08/13/2026`, `2026-08-13`, `Aug 13`    |
| `time`    | `h[:mm]AM\|PM`, no space, no zone; drop `:00`       | `12PM`, `1:15PM`, `5PM`          | `12:00 PM`, `noon`, `12PM ET`, `17:00`  |
| `percent` | three decimals then `%`                             | `2.000%`, `0.000%`, `7.250%`     | `2%`, `2.00%`, `200bps`, `S+200`        |
| `mm`      | millions, three decimals                            | `500.000`, `2157.000`            | `500`, `$500MM`, `2,157.000`            |
| `price`   | three decimals                                      | `99.500`, `100.000`              | `99.5`, `99 1/2`, `par`                 |
| `integer` | digits only                                         | `3`, `25`                        | `3.0`, `25 bps`                         |
| `boolean` | `Yes` or `No`; blank when unknown                   | `Yes`, `No`                      | `Y`, `TRUE`, `yes`                      |
| `enum`    | one of the listed values, spelled exactly           | `Amend & Extend`                 | `A&E`, `Amend and Extend`, `LOAN`       |
| `string`  | free text; a `max_length` or `pattern` where stated | `7 yr`                           | `7yr`, `7 years` (Maturity Terms)       |

A `percent` always has exactly three decimals: `S+200` is `2.000%`, never `2%` or `2.0%`. An `mm`
value always has exactly three decimals: `$700,000,000` is `700.000`.

## Defaults

Two columns are never blank on a staged record:

| Column          | Default  |
| --------------- | -------- |
| Pipeline Status | `New`    |
| % Commit        | `0.000%` |

Every other column is blank unless a rule in `deal-parsing`, a format skill, or a recalled memory
supplies a value.

## Columns, in order

`R` marks the OMS's minimum insert set: a blank in one of these fails the upload.

| #  | Label                            | Type      | Allowed values / constraint                                                                          |
| -- | -------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| 1  | Pipeline Status                  | enum  R   | `New`, `Pass`, `Play`, `Pipeline Closed` — always `New` when staged                                  |
| 2  | Pipeline Type                    | enum  R   | `Loan`, `Bond`                                                                                       |
| 3  | Opportunity Name                 | string R  | ≤ 60 characters; no `$`, no amounts                                                                  |
| 4  | Region                           | enum      | `North America`, `Europe`, `Asia Pacific`, `Latin America`, `Global`                                 |
| 5  | Sponsors                         | string    | names joined by ` / `, or `Public`                                                                   |
| 6  | Left Agent                       | string    |                                                                                                      |
| 7  | Right Agent                      | string    |                                                                                                      |
| 8  | Priority                         | boolean   | internal — blank                                                                                     |
| 9  | Play?                            | enum      | `Yes`, `No` — internal, blank                                                                        |
| 10 | Trader                           | string    | internal — blank                                                                                     |
| 11 | VP at Issue                      | string    | internal — blank                                                                                     |
| 12 | Industry                         | string    |                                                                                                      |
| 13 | Own Issuer?                      | boolean   | internal — blank                                                                                     |
| 14 | Relevant Leverage                | string    | internal — blank                                                                                     |
| 15 | Relevant LTV                     | string    | internal — blank                                                                                     |
| 16 | Priced?                          | boolean   | `Yes`, `No`                                                                                          |
| 17 | Played?                          | boolean   | internal — blank                                                                                     |
| 18 | Date Arrived                     | date  R   |                                                                                                      |
| 19 | Launch Date                      | date      |                                                                                                      |
| 20 | Commit Due                       | date      |                                                                                                      |
| 21 | Commit Due Time                  | time      |                                                                                                      |
| 22 | Date Recommendation Received     | date      | internal — blank                                                                                     |
| 23 | Commit Date                      | date      | internal — blank                                                                                     |
| 24 | Funding Date                     | date      | internal — blank                                                                                     |
| 25 | Asset                            | string    | security master asset id                                                                             |
| 26 | Maturity Date                    | date      |                                                                                                      |
| 27 | Maturity Terms                   | string R  | pattern `^\d+(\.\d+)? yr$` — `7 yr`, `4.5 yr`                                                        |
| 28 | Currency                         | enum  R   | `USD`, `EUR`, `GBP`, `CAD`                                                                           |
| 29 | Issue Size (MM)                  | mm    R   |                                                                                                      |
| 30 | New Money (MM)                   | mm        |                                                                                                      |
| 31 | Call Protection                  | string    |                                                                                                      |
| 32 | Is Secured?                      | boolean   | `Yes`, `No`                                                                                          |
| 33 | Secured Level                    | enum      | `Senior Secured`, `First Lien`, `Second Lien`, `Senior Unsecured`, `Subordinated`                    |
| 34 | Security Type                    | enum  R   | `Loan`, `Bond`                                                                                       |
| 35 | UOP                              | enum      | `Refinance`, `Amend & Extend`, `Acquisition`, `LBO`, `Dividend Recap`, `General Corporate Purposes`, `Project Finance`, `Other` |
| 36 | Notes                            | string    | ≤ 200 characters                                                                                     |
| 37 | Early Look                       | string    | internal — blank                                                                                     |
| 38 | Covenant Status #                | integer   | 1 to 4                                                                                               |
| 39 | BPS Taken Out                    | integer   |                                                                                                      |
| 40 | Is Revolver?                     | boolean   | `Yes`, `No`                                                                                          |
| 41 | Fixed/Floating                   | enum  R   | `Fixed`, `Floating`                                                                                  |
| 42 | Initial Coupon/Spread Talk Low   | percent   |                                                                                                      |
| 43 | Initial Coupon/Spread Talk High  | percent   |                                                                                                      |
| 44 | Initial Issue Price Talk Low     | price     |                                                                                                      |
| 45 | Initial Issue Price Talk High    | price     |                                                                                                      |
| 46 | Floor Talk                       | percent   | blank on Bond records                                                                                |
| 47 | Coupon/Spread Talk Low           | percent   |                                                                                                      |
| 48 | Coupon/Spread Talk High          | percent   |                                                                                                      |
| 49 | Issue Price Talk Low             | price     | post-pricing — blank                                                                                 |
| 50 | Issue Price Talk High            | price     | post-pricing — blank                                                                                 |
| 51 | Final Floor                      | percent   |                                                                                                      |
| 52 | Final Coupon/Spread              | percent   | post-pricing — blank                                                                                 |
| 53 | Final Yield                      | percent   |                                                                                                      |
| 54 | Issue Price Final                | price     | post-pricing — blank                                                                                 |
| 55 | Desk Notes                       | string    | internal — blank                                                                                     |
| 56 | S&P Issue Rating                 | string    |                                                                                                      |
| 57 | Moody's Issue Rating             | string    |                                                                                                      |
| 58 | Fitch Issue Rating               | string    |                                                                                                      |
| 59 | S&P Corp Rating                  | string    |                                                                                                      |
| 60 | Moody's Corp Rating              | string    |                                                                                                      |
| 61 | Fitch Corp Rating                | string    |                                                                                                      |
| 62 | S&P Recovery Rating              | string    |                                                                                                      |
| 63 | Liquidity Score                  | string    |                                                                                                      |
| 64 | Is Investment Grade?             | boolean   | `Yes`, `No`                                                                                          |
| 65 | Primary Trade                    | string    | internal — blank                                                                                     |
| 66 | Commit Amount (MM)               | mm        | internal — blank                                                                                     |
| 67 | % Commit                         | percent   | default `0.000%`                                                                                     |
| 68 | Fund Order (MM)                  | mm        | internal — blank                                                                                     |
| 69 | % Fill Fund Order                | percent   | internal — blank                                                                                     |
| 70 | Allocation Amount (MM)           | mm        | internal — blank                                                                                     |
| 71 | % Fill Market Order              | percent   | internal — blank                                                                                     |
| 72 | Trade Date                       | date      | internal — blank                                                                                     |
| 73 | Counterparty                     | string    | internal — blank                                                                                     |
| 74 | Allocation Comments              | string    | internal — blank                                                                                     |

## Business rules the OMS applies after the format check

The OMS also checks relationships between columns. The two the format alone does not imply:

- A **Bond** record must have `Fixed/Floating = Fixed` and a blank `Floor Talk`.
- **Opportunity Name** must be at most 60 characters and must not contain `$` or an amount
  (`500MM`, `1.25bn`). Lien levels (`1L`, `2L`) are fine.

Other OMS rules exist and are reported back as error codes with a hint when a file is rejected.
The desk adds parsing rules for them through the assistant; do not anticipate them here.

## Example

A fictional loan launch, header abbreviated to the first columns:

```
Pipeline Status,Pipeline Type,Opportunity Name,Region,Sponsors,Left Agent,Right Agent,…
New,Loan,Cascade Midstream 1L TLB,North America,Granite Peak Capital,Ashgrove Capital Markets,Kestrel Bank,…
```

and further along the same row: `…,7 yr,USD,700.000,,"101 Soft Call until the later of (i) 12
months or (ii) In Service Date",Yes,Senior Secured,Loan,Project Finance,…` — the Call Protection
cell is quoted because it contains commas; the empty New Money cell is two adjacent commas.

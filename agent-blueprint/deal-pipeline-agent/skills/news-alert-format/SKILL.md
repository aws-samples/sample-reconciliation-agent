---
name: news-alert-format
description: How to read a prose market news alert about a new-issue deal. Sentence patterns for launch, arrangers, talk, fungibility, deadlines and ratings, the Entity/Topic footer, and what to ignore.
metadata: { tier: "format", applies_to: ["news-alert"] }
---

# Reading a market news alert

A market news alert is a short prose wire from a news service, forwarded to the desk's inbox. It
has no term-sheet table: every fact is inside a sentence, and the sentences follow a small number
of recurring patterns. This skill names those patterns and says which `deal-parsing` field each
one feeds. Apply `deal-parsing` for the conversions and formats; this skill only tells you where
to look.

## Shape of an alert

1. **Subject line** — issuer, action and headline size: "Northwind Automotive launches $500M
   add-on TLB; commitments due Aug. 13", "Ridgeline Packaging sets price talk on $600M senior
   secured notes; pricing expected today". The subject names the deal you are staging (U1) and
   tells you its stage (launch, price talk, pricing).
2. **Lead paragraph** — issuer, instrument, size, lead bank, purpose, deadline.
3. **Terms paragraph** — OID, spread or coupon talk, floor, yield, fungibility, call protection.
4. **Context paragraphs** — what is being refinanced, other outstanding debt, ratings, borrower
   entities, company description with ticker.
5. **Footer** — `Entity mentions:`, `Topic mentions:`, `Source:` lines.

Wires hedge with "according to sources": that phrase does not lower confidence. The alert is the
desk's source of record for the day; a fact the wire states plainly is `high`.

## Sentence patterns and the fields they feed

### Launch and arrangers

| Pattern                                                                                                   | Fields                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "**X has launched** a $500 million **add-on term loan B** through a **Harbor Point Securities-led** arranger group" | Launch Date = sent date (`high`); Issue Size `500.000`; Pipeline Type / Security Type `Loan`, Fixed/Floating `Floating`; Opportunity Name qualifier `add-on`; **Left Agent = the bank in "<Bank>-led", as written** (`Harbor Point Securities`). |
| "**X is left lead** on the offering, with **Y** and **Z** as joint bookrunners"                            | Left Agent `X`; Right Agent `Y` (the first joint bookrunner). `Z` is not recorded.                                                                                                                              |
| "led by X and Y" / "X and Y are the joint lead arrangers" with no left marker                             | Left Agent `X` (first named), Right Agent `Y`.                                                                                                                                                                 |
| "**has set price talk** on its $600 million offering of **eight-year senior secured notes**"               | Pipeline Type / Security Type `Bond`, Fixed/Floating `Fixed`; Issue Size `600.000`; Maturity Terms `8 yr`; Is Secured? `Yes`, Secured Level `Senior Secured`. No explicit launch date → Launch Date = sent date at `low` confidence with an assumption. |
| "the deal **is expected to price** this afternoon" / "pricing expected today"                             | Priced? `No`. Nothing is final yet.                                                                                                                                                                            |
| "**priced** its $X term loan at S+350 with a 0% floor and an OID of 99.5" / "**priced to yield** 7.375%"   | Priced? `Yes`; Final Yield from "priced to yield"; Final Floor from the stated floor. Spread and price at pricing belong to the post-pricing columns, which the parser leaves blank (U9).                       |

### Purpose

| Pattern                                                                                                            | Fields                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| "the proceeds of which will be used **to refinance** notes"                                                        | UOP `Refinance`.                                                                                           |
| "Proceeds will be used to refinance the company's $500 million issue of 7.00% senior secured notes due April 2028" | Notes: condensed detail. The "senior secured" here describes the **notes being refinanced**, not the loan — it does not set Is Secured? on this record. |
| "Proceeds, together with cash on hand, will be used **to fund the acquisition** of a regional competitor"           | UOP `Acquisition`; Notes: condensed detail.                                                                |
| "to fund a **dividend** to the sponsor" / "to **repay revolver borrowings** and for **general corporate purposes**" | UOP `Dividend Recap` / `Refinance` (primary purpose first, U6).                                             |

### Talk, fungibility and structure

| Pattern                                                                                                                                             | Fields                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "The add-on **is offered at an OID of 99.5-99.75**"                                                                                                 | Initial Issue Price Talk Low `99.500`, High `99.750`.                                                                                                                                                                          |
| "will be **fungible with the existing** $621 million covenant-lite TLB **due January 2031** that **is priced at S+200, with a 0% floor**"           | The pricing describes the **existing** tranche. Because the add-on is fungible it carries the same economics: Initial Coupon/Spread Talk `2.000%` / `2.000%`, Floor Talk `0.000%` (`medium`, rule U3). "due January 2031" gives the maturity → Maturity Terms derived from the launch date (U4), Maturity Date blank. `$621 million` is **not** the Issue Size. "covenant-lite" may be mentioned in Notes. |
| "At talk, **the yield to maturity is 5.95%-6.02%**"                                                                                                 | Talk, not final: Final Yield blank. There is no column for yield talk.                                                                                                                                                         |
| "**Talk is in the 7.25%-7.50% area**" (bond)                                                                                                        | Initial Coupon/Spread Talk Low `7.250%`, High `7.500%`. Floor Talk blank (Bond).                                                                                                                                               |
| "The **101 soft call** protection will be reset for six months"                                                                                     | Call Protection `101 soft call protection reset for six months`.                                                                                                                                                               |
| "The notes will be **non-callable for three years**, with a first call at par plus 50% of the coupon"                                                | Call Protection `Non-callable for three years, first call at par plus 50% of the coupon`.                                                                                                                                      |
| "**Commitments are due by noon ET Thursday, Aug. 13**"                                                                                              | Commit Due `8/13/<year of the sent date>`; Commit Due Time `12PM`. Weekday and "ET" are dropped.                                                                                                                                |
| "Investor calls were held yesterday" (bond)                                                                                                         | No commitments deadline: Commit Due and Commit Due Time blank. Not a launch date.                                                                                                                                               |

### Ratings

| Pattern                                                                                                                    | Fields                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "Current **facility ratings are BBB-/Ba1**, with a **recovery rating of 1** from the rating agency"                        | S&P Issue `BBB-`, Moody's Issue `Ba1` (assigned by notation, U7); S&P Recovery Rating `1`.                                  |
| "**corporate ratings are BB/Ba3**, with stable outlooks"                                                                   | S&P Corp `BB`, Moody's Corp `Ba3`. Outlook dropped.                                                                         |
| "The **notes are rated B+/B2**, and the **corporate ratings are B/B2**"                                                    | S&P Issue `B+`, Moody's Issue `B2`; S&P Corp `B`, Moody's Corp `B2`.                                                        |
| "ratings are expected" / "unrated" / no ratings sentence                                                                   | All rating columns blank.                                                                                                   |

### Issuer, borrowers, ownership

| Pattern                                                                                              | Fields                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "**X US LLC and X Global Holdings S.a r.l. are the borrowers**"                                      | Borrowing entities. The issuer for the lookup and the Opportunity Name is the parent in the headline (U5).                                                          |
| "X **(NYSE: NWND)** is a global automotive seating supplier…"                                        | A ticker means listed: Sponsors `Public` (`medium`). The description is context only — Industry and Region come from the security master (U8).                     |
| "X is a **privately held** manufacturer…" / "a portfolio company of **Tidewater Partners**"           | No ticker → Sponsors from the email if a sponsor is named, else from the security master.                                                                          |

## The footer

```
Entity mentions: Northwind Automotive, Harbor Point Securities
Topic mentions: Covenant-Lite, Launch, Leveraged Loan, Refinancing
Source: Leveraged Finance Wire | staff
```

- **Entity mentions** confirms the issuer name and the lead bank's name as the wire spells them.
  Use it to check your Left Agent spelling and your lookup name; it is not itself evidence for a
  field, because it does not say which entity plays which role.
- **Topic mentions** confirms the stage and type (`Launch`, `Price Talk`, `Pricing`,
  `Leveraged Loan`, `High-Yield Bonds`, `Refinancing`, `Acquisition Financing`). A `Pricing` topic
  without a "priced at" sentence is still `Priced? = No` — the sentence decides, not the tag.
- **Source** is noise.

## What to ignore

- **Other outstanding debt** — "the company has two issues of senior unsecured notes that are not
  part of the current refinancing: $500 million of 8.25% notes due April 2031 and $795 million of
  7.50% notes due February 2033". Context for Notes at most; never a size, rating, maturity or
  security level for this record.
- **The existing tranche's size** on a fungible add-on ("the existing $621 million TLB") — only
  its spread, floor and maturity carry over (U3, U4).
- **Coupons of debt being refinanced** ("7.00% senior secured notes") — not this deal's coupon.
- **Company descriptions** ("approximately 200 manufacturing facilities in 29 countries") — the
  security master supplies Industry and Region.
- **Hedges and attributions** ("according to sources", "| staff").

## Checklist before staging

- Issuer taken from the headline, looked up once.
- Left Agent spelled exactly as the wire spells it.
- Stage identified from the verbs (launched / set talk / priced) and reflected in Launch Date
  confidence and Priced?.
- Every number that came from the fungible tranche is marked `medium` with rule U3, and its
  assumption is recorded.
- Commit Due year taken from the Sent header.

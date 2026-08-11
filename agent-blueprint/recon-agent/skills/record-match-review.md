---
name: record-match-review
description: Compare the two sides' economic attributes (account name, amount, entry type) with tolerance and aggregation to confirm or refute a match.
tools: [general-ledger___search_ledger]
---

Confirm or refute a match by comparing the **economic identity** of the two reconciliation
sides — never the document filename or an incidental reference/identifier (a ledger reference is
a wire/transaction code, not the uploaded file name). Compare these three attributes:

1. **Account name** — the borrower / counterparty. The ledger side carries it in the `borrower`
   column; the document side carries it as the extracted counterparty name. They should name the
   same entity (allow for casing and legal-suffix variants, e.g. "INC." vs "Inc").
2. **Amount** — apply the configured tolerance band to the numeric amounts, and account for
   **aggregation**: several ledger records on one side may sum to a single amount on the other
   (e.g. one wire settling multiple facilities). Compare component-to-component and
   sum-to-total.
3. **Entry type** — the CREDIT/DEBIT direction must agree. A cash-receipt/settlement notice
   (interest, paydown, principal, fee, rate-set, borrowing draw) is a **CREDIT** to the cash
   account; a cancellation/withdrawal/reversal notice is a **DEBIT**. A direction mismatch
   refutes the match even when the amount is within tolerance.

Query the ledger by borrower (and amount range when helpful) to pull candidate rows, then reason
over the three attributes above. Note exact matches, near-matches within tolerance, aggregation
relationships, and any mismatches.

Always conclude with: (1) a one-paragraph **reasoning** of which attributes matched, which
differed, and by how much, (2) a **confidence** score in [0,1], and (3) the **evidence** list
(the specific attribute values you compared — account name, amounts, entry type). These populate
the case's ReasoningStep.

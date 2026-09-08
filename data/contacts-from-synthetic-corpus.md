# Contacts to create from the synthetic corpus

Every email address below was read out of the committed sample data in this repo:

- `data/kb-seed/retrieved_emails/*.html` — the correspondence archive the agent's
  `search_correspondence` tool actually searches.
- `data/input/*/*.pdf` — the notice documents the extraction pipeline reads (text pulled with
  `pdftotext -layout`).

Create these on **Config → Email contacts**. `kind` matters: an `internal_notification` address is
authorized by being an active row on this list, while a `counterparty` address additionally has to
clear the deployment's send gate.

## Read this before you create the counterparty rows

Every counterparty address in the corpus sits in an **RFC 2606 / RFC 6761 reserved domain**
(`.example`, `.example.com`, `.example.net`, `.example.org`). Those domains exist so documentation
cannot accidentally name a real mailbox, and no mail is deliverable to any of them.

The send gate is the terraform variable `counterparty_email_domains`, set in
`infra/environments/recon/terraform.tfvars`. A deployment typically holds a single tenant domain
there — this document writes it as the reserved `contoso.onmicrosoft.com`, because a real tenant
domain belongs in that gitignored file and nowhere else.

**The gate is read by the gateway request interceptor and by nothing else.** The contacts panel does
not consult it, so a faithful-to-corpus counterparty contact simply **saves, with no commentary**;
the refusal happens later, when the interceptor resolves the address on the send. Owning the contact
list and owning the egress policy are different jobs, and only the second one is a gate.

That leaves you a choice:

| Goal                                                    | What to create                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A demo that mirrors the documents an analyst is reading | The corpus addresses below, verbatim. Drafts render, approval works, the send is refused.         |
| A demo that actually delivers mail                      | The same display names, with the local part re-pointed at the tenant domain (see the last table). |

Both are legitimate. Nothing forces the two to agree, because `recipient_hint` — the string the
agent matches a contact against — is the **display name**, not the address.

## Internal notification

**LoanMesa** is the operator in this corpus: the loan administrator running the reconciliation, on
whose behalf the agent works. The Activity Memo's addressee block names it directly
(`To: LoanMesa / Evergreen Specialty Finance, Inc.`). Its own desks are internal, not counterparties.

At least one `internal_notification` contact must stay active — the API returns 409 rather than let
you deactivate the last one, because escalation mail would then have nowhere to go.

| Email                         | Display name            | Kind                    |
| ----------------------------- | ----------------------- | ----------------------- |
| `loan-ops@loanmesa.example`   | LoanMesa Loan Ops       | `internal_notification` |
| `recon-team@loanmesa.example` | LoanMesa Reconciliation | `internal_notification` |

## Counterparty — from the correspondence archive

These three appear as real senders in `data/kb-seed/retrieved_emails/`, so they are the addresses a
proposal's `email_draft` will most plausibly cite: the agent has read a thread from them.

| Email                                 | Display name                                        | Kind           |
| ------------------------------------- | --------------------------------------------------- | -------------- |
| `loan.ops@meridian-agent.example`     | Meridian Agency Services LLC — Loan Operations      | `counterparty` |
| `loan.ops@tarnsmoor-trust.example`    | Tarnsmoor Trust Bank, N.A. — Loan Operations        | `counterparty` |
| `settlements@coastline-trust.example` | Coastline Trust Company — Settlements (M. Oyelaran) | `counterparty` |

Coastline is the **custodian**, and the only invented party in the archive — agent-bank notices never
identify the recipient's custodian, so there is nothing in `data/input/` to draw it from. It is
deliberately not named "Meridian" anything: the archive's whole job is teaching the agent to tell a
custodian's view of a payment from the agent bank's, and two near-identical names defeat that.

## Counterparty — from the notice PDFs

Contact addresses printed in the notice documents themselves. Useful when the case under
investigation is a notice rather than a mail thread.

| Email                                          | Display name                            | Kind           |
| ---------------------------------------------- | --------------------------------------- | -------------- |
| `loan.ops@meridian-agent.example`              | Meridian Agent — Loan Ops               | `counterparty` |
| `cancellations@meridian-agent.example`         | Meridian Agent — Cancellations          | `counterparty` |
| `agency@tarnsmoortrustbank.example`            | Tarnsmoor Trust Bank — Agency           | `counterparty` |
| `uslenderrelations@tarnsmoortrustbank.example` | Tarnsmoor Trust Bank — Lender Relations | `counterparty` |
| `fees@tarnsmoor-trust.example`                 | Tarnsmoor Trust Bank — Agency Fees      | `counterparty` |
| `rsanjay@tarnsmoortrustcapital.example`        | Tarnsmoor Trust Capital (R. Sanjay)     | `counterparty` |
| `dcranmore@greystrandcredit.example`           | Greystrand Credit (D. Cranmore)         | `counterparty` |

`AGENCY@tarnsmoortrustbank.example` is printed uppercase on two paydown notices; it is the same
mailbox as the lowercase row above, so create it once.

Only some of these are greppable in a notice PDF's bytes. The rest are readable only in the IDP
ground truth under `data/input/idp-evaluation/`, because a notice whose content stream is compressed
hides its text from a grep while showing it plainly to anyone who opens the file. Both places count
as the corpus: `tests/input_corpus/` sweeps them for deliverable addresses, and
`tests/data_corpus/` does the same for this file.

## Sendable equivalents for a working demo

Same display names, addresses inside the tenant domain, so `counterparty_email_domains` admits them
and the gateway forwards the send. `contoso.onmicrosoft.com` below is a reserved placeholder —
substitute your own tenant domain, and keep the real one out of anything committed.

| Email                                           | Display name                                   | Kind                    |
| ----------------------------------------------- | ---------------------------------------------- | ----------------------- |
| `meridian.loanops@contoso.onmicrosoft.com`      | Meridian Agency Services LLC — Loan Operations | `counterparty`          |
| `tarnsmoor.loanops@contoso.onmicrosoft.com`     | Tarnsmoor Trust Bank, N.A. — Loan Operations   | `counterparty`          |
| `coastline.settlements@contoso.onmicrosoft.com` | Coastline Trust Company — Settlements          | `counterparty`          |
| `loan.ops@contoso.onmicrosoft.com`              | LoanMesa Loan Ops                              | `internal_notification` |

These need real mailboxes behind them if you want to _read_ what was sent — the tenant either has to
have them provisioned, or they have to be aliases on the shared mailbox `GRAPH_MAILBOX` already sends
from.

## Borrowers are not contacts

`data/notices/notices-seed.json` names three borrowers — CINDERMOOR LOGISTICS HOLDINGS INC.,
MISTFELL FOODS CORP., NORTHWIND MANUFACTURING LLC. They carry no email address anywhere in the
corpus, and they are the subject of the reconciliation rather than a party to the correspondence:
the agent writes to the agent bank about a borrower, never to the borrower. No contact rows.

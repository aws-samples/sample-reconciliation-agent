# Playbook — Timing difference

Conventions for a **timing** break. Whether an item is inside its grace period is decided by
configuration and the procedure in `ledger-status-resolution`; this is the counterparty-specific
knowledge that procedure depends on.

**Settlement calendars are per-counterparty and not in this corpus.** Where an offset looks larger than
the configured window, check the counterparty's own calendar through the live SharePoint route before
concluding the cash is late. A market holiday at the agent bank is the most common explanation for an
offset that looks like a two-day delay, and it is invisible from the item's own data.

**Value date versus posting date.** Counterparties state a value date; the book of record posts on its
own cycle. A difference between the two is a bookkeeping artefact, not a timing break — compare value
date to value date.

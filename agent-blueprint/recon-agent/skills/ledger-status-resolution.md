---
name: ledger-status-resolution
description: Resolve a confirmed break by proposing a ledger status update, executed via the Policy-gated set-draw-status___set_draw_status write.
tools: [set-draw-status___set_draw_status]
---

Once the investigation confirms how a break should be resolved, the resolution is recorded as a
draw/ledger **status update**. This is the terminal action for most classes — it applies across
break patterns, so it is not a classification type the classifier picks; it is the resolution
step the agent proposes after its read-only investigation.

The write goes through the **`set-draw-status___set_draw_status`** Gateway tool, which records the mutation in the
GL **status overlay** (the authoritative general ledger stays read-only; `general-ledger___search_ledger` merges
the overlay onto its results). Two hard guardrails apply — do not try to work around either:

1. **Status allowlist.** The only proposable statuses are `Confirmed`, `Cancelled`, `OnHold`,
   and `Amended`. Any other value is rejected by both the model schema and the Lambda.
2. **Reference provenance.** You do NOT supply the ledger `reference`. It is derived from your
   recorded `general-ledger___search_ledger` results: exactly **one** distinct matched reference ⇒ that reference
   is used; **zero or more than one** ⇒ there is nothing safe to write, so no status update is
   proposed (escalate for human handling instead). This prevents a model from redirecting a
   write to an arbitrary record.

The write is **confidence-gated by AgentCore Policy**. The agent never calls `set-draw-status___set_draw_status`
directly — it emits an `execute` proposal with the intended status/reason, and the worker (or
the human-approve path) performs the Policy-gated write only when the computed composite
confidence clears the admin threshold; below threshold the status update is queued in the
proposal for human approval.

Tool: `set-draw-status___set_draw_status(reference, status, reason?, confidence)` → writes one idempotent row to
the GL status overlay (reference supplied by the worker, not the model).

Always conclude with: (1) a one-paragraph **reasoning** of why this status resolves the break
and which evidence supports it, (2) a **confidence** score in [0,1] for the proposed status, and
(3) the **evidence** list (the `general-ledger___search_ledger` reference and the corroborating values). These
populate the case's ReasoningStep.

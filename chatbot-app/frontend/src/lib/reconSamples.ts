// Canonical sample payloads for the queue's "Create New" action.
//
// Labelled by the CUJ's SCENARIOS rather than by pipeline mechanics, because that is the vocabulary an
// operator demoing against the CUJ is looking for — "Scenario 2" is findable in this list, "no rule
// matched" is not. The pipeline branch each one drives has not been dropped; it moved into the
// `expectation` text, where it belongs with the rest of what to expect.
//
// ⚠️ Scenarios 1, 2, 3 and 4 all carry TWO sides and therefore reach the SAME Tier-1 classification.
// `BREAK_TYPE_RULES` partitions on side count and cannot see which side is zero, so it cannot tell a
// missing booking from missing cash. That is a known limitation, not a bug in these samples, and every
// one of those four expectations says so — a modal implying a discrimination the platform does not make
// is the single most likely thing for a demo audience to take away wrongly.
//
// The branches are pinned to what actually decides them:
//   - auto-clear vs escalate: `backend/tier1/handler.py`'s `_RULES` — domain `cash`, match_attr
//     `amount`, tolerance 0.05.
//   - which break type: `BREAK_TYPE_RULES` in `backend/tier1/classify.py`, which partitions on
//     `side_count` (2 -> record-match-review, 0 -> ledger-status-resolution, anything else -> no
//     class at all). Every sample here carries one or two sides. Nothing in this list submits a
//     zero-sided item: that shape reaches Tier-1 from the extraction pipeline, which is where it is
//     exercised, and hand-typing one here would demo a path no document actually takes.
//
// `sides[].attributes` values are strings on purpose: ReconSide.attributes is dict[str, str] in
// backend/recon_core/schema.py, and a number there fails pydantic validation at intake. The
// item-level `attributes` bag is free-form `dict`, so numbers and nesting are fine there. That applies
// to a zeroed side too: "0.00", not 0.
//
// Keys are lowercase throughout. `Currency` used to be capitalised next to a lowercase `amount` in the
// same object; only `amount` is the match attribute so nothing behaved differently, but an operator
// copying a sample has no way to know that, and both the ledger and the notice use lowercase.

export interface ReconSamplePayload {
  label: string;
  /** What the pipeline should do with it — shown next to the sample in the UI. */
  expectation: string;
  payload: { domain: string; items: Record<string, unknown>[] };
}

// item_id must be unique per submission: intake's put_if_absent SKIPS an existing id rather than
// overwriting, so a re-run with a fixed id silently writes nothing. The UI suffixes these.
export const RECON_SAMPLES: ReconSamplePayload[] = [
  {
    label: "Auto-clear (within tolerance)",
    expectation:
      "Amounts differ by 0.02, inside the 0.05 tolerance → Tier-1 resolves it deterministically, AUTO_CLEARED, the agent never runs.",
    payload: {
      domain: "cash",
      items: [
        {
          item_id: "manual-autoclear-1",
          sides: [
            { name: "bank", attributes: { amount: "100.00", currency: "USD" } },
            {
              name: "ledger",
              attributes: { amount: "100.02", currency: "USD" },
            },
          ],
          source_refs: ["manual-submission"],
        },
      ],
    },
  },
  {
    label: "Scenario 1 — bank cash, no ledger booking",
    expectation:
      "Bank cash arrived and the book of record has nothing against it (ledger side 0.00) → " +
      "tolerance_miss → record-match-review. The agent's job is to find the notice that explains the " +
      "cash and propose a booking. Tier-1 cannot distinguish this from Scenario 2 — both are " +
      "two-sided with one side zeroed, and the rule table reads only the side COUNT.",
    payload: {
      domain: "cash",
      items: [
        {
          item_id: "manual-scenario1-1",
          sides: [
            {
              name: "bank",
              attributes: { amount: "12500.00", currency: "USD" },
            },
            // Zeroed, not omitted. A one-sided item matches no rule at all and lands in the agent's own
            // classifier; a zeroed side is how a real break carries "this side has nothing".
            {
              name: "ledger",
              attributes: { amount: "0.00", currency: "USD" },
            },
          ],
          source_refs: ["manual-submission"],
        },
      ],
    },
  },
  {
    label: "Scenario 2 — ledger booking, no applied bank cash",
    expectation:
      "The book of record expects cash that has not arrived (bank side 0.00) → tolerance_miss → " +
      "record-match-review. The outcome depends on TIME: inside the grace period the item waits, past " +
      "it the agent proposes a chase to the contact on the matched notice. Tier-1 sees the same shape " +
      "as Scenario 1 and cannot tell them apart.",
    payload: {
      domain: "cash",
      items: [
        {
          item_id: "manual-scenario2-1",
          sides: [
            {
              name: "bank",
              attributes: { amount: "0.00", currency: "USD" },
            },
            {
              name: "ledger",
              attributes: { amount: "842155.20", currency: "USD" },
            },
          ],
          source_refs: ["manual-submission"],
        },
      ],
    },
  },
  {
    label: "Scenario 3 — both sides booked, amounts differ",
    expectation:
      "Both sides carry cash and the amounts disagree by 450 → tier1_escalation_reason=tolerance_miss, " +
      "tier1_break_type=record-match-review (side_count 2). Tier-1 cannot distinguish this from " +
      "Scenarios 1, 2 and 4 — all four are two-sided; the agent separates them from the line items.",
    payload: {
      domain: "cash",
      items: [
        {
          item_id: "manual-scenario3-1",
          sides: [
            {
              name: "bank",
              attributes: { amount: "12500.00", currency: "USD" },
            },
            {
              name: "ledger",
              attributes: { amount: "12050.00", currency: "USD" },
            },
          ],
          source_refs: ["manual-submission"],
        },
      ],
    },
  },
  {
    label: "Scenario 4 — rollover notice, no standalone cash expected",
    expectation:
      "Shaped like Scenario 2, but the only candidate notice is a ROLLOVER: it proves the rate was " +
      "reset, not that cash was due. The agent must refuse to call it a confirmed cash match, surface " +
      "both contract ids, and cap its confidence — no matter how well fund, date and facility align. " +
      "Tier-1 cannot distinguish this from Scenario 2: the overlay comes from the NOTICE, not the item.",
    payload: {
      domain: "cash",
      items: [
        {
          item_id: "manual-scenario4-1",
          sides: [
            {
              name: "bank",
              attributes: { amount: "0.00", currency: "USD" },
            },
            {
              name: "ledger",
              attributes: { amount: "24000000.00", currency: "USD" },
            },
          ],
          source_refs: ["manual-submission"],
          // The overlay is decided by the notice's activity_type, so the item has to carry enough for
          // the agent to find that notice: the facility and the window it sits in.
          attributes: {
            activity_type: "Rollover",
            facility: "NORTHWIND REVOLVING CREDIT FACILITY",
            value_date: "2026-01-26",
          },
        },
      ],
    },
  },
  // `BREAK_TYPE_RULES` covers side_count 2 and 0, so a ONE-sided item is what keeps the agent's own
  // classifier on a live path. Without this sample the model classification route ships untested.
  {
    label: "Unknown — insufficient data",
    expectation:
      "One side, and its label maps to neither of the two the classifier knows → side_count 1 → " +
      "tier1_escalation_reason=side_count and NO tier1_break_type at all. The agent classifies from " +
      "scratch and must escalate naming WHICH dimension was missing, never a generic no-match.",
    payload: {
      domain: "cash",
      items: [
        {
          item_id: "manual-unknown-1",
          sides: [
            {
              // An unmapped side label: the item names a side the input-side mapping does not resolve,
              // which is "a line-item input side is unmapped" rather than a missing amount.
              name: "unmapped",
              attributes: { borrower: "Northwind Capital", amount: "48750.00" },
            },
          ],
          source_refs: ["manual-submission"],
        },
      ],
    },
  },
];

/**
 * Suffix every item_id so a resubmission is a NEW item (intake skips duplicates).
 *
 * @param payload the sample payload to copy.
 * @param suffix appended to each item_id after a hyphen.
 * @returns a new payload; the input is not mutated, because the samples are module-level constants
 *   and a mutated one would carry the previous run's suffix.
 */
export function withUniqueIds(
  payload: ReconSamplePayload["payload"],
  suffix: string,
): ReconSamplePayload["payload"] {
  return {
    ...payload,
    items: payload.items.map((it) => ({
      ...it,
      item_id: `${it.item_id}-${suffix}`,
    })),
  };
}

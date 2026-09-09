"use client";

import type { Tier1Match } from "@/lib/reconApi";
import { Eyebrow, Panel } from "@/components/recon/ui";

// How a case cleared without a model and without a human.
//
// This panel exists because the case screen was written for the escalated path and reused verbatim
// for the deterministic one. Every agent panel rendered empty on an auto-cleared case, and one told
// the operator the case "escalates for a human decision" — the opposite of what happened. The
// platform's best outcome was the one it could not account for.
//
// It is the counterpart of Tier1RoutingPanel: that one explains why Tier-1 gave up, this one
// explains why it did not have to. The two are mutually exclusive by construction, since the case
// row carries either an escalation reason or a match, never both.

/** A label/value row, rendered only when there is a value. */
function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-[var(--rc-ink-faint)]">{label}</dt>
      <dd className="text-[var(--rc-ink)]">{value}</dd>
    </>
  );
}

export function Tier1ResolutionPanel({
  match,
  category,
}: {
  match?: Tier1Match | null;
  category?: string | null;
}) {
  // `matched_on` is the discriminator, but fall back to inspecting the fields for rows written
  // before it was recorded rather than refusing to render them. An operator judging whether this
  // fix worked will open an old case first.
  const viaLedger =
    match?.matched_on === "general_ledger" ||
    (!match?.matched_on && !!match?.ledger_row);

  return (
    <Panel className="rc-rise space-y-3 p-5">
      <Eyebrow>Tier-1 Deterministic Resolution</Eyebrow>
      <p className="rc-mono text-[12px] leading-relaxed text-[var(--rc-green)]">
        This case was resolved by the deterministic tier. No model was invoked
        and no human decision is required.
      </p>

      {match ? (
        <dl className="rc-mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          <Row label="Cleared as" value={category ?? undefined} />
          {viaLedger ? (
            <>
              <Row label="Matched against" value="general ledger" />
              <Row label="Borrower" value={match.borrower} />
              <Row label="Entry type" value={match.entry_type} />
              <Row label="Extracted amount" value={match.extracted_amount} />
              <Row label="Ledger amount" value={match.ledger_amount} />
            </>
          ) : (
            <>
              <Row label="Rule domain" value={match.rule_domain} />
              <Row label="Compared attribute" value={match.match_attr} />
              <Row
                label={match.side_a_name ?? "Side A"}
                value={match.side_a_value}
              />
              <Row
                label={match.side_b_name ?? "Side B"}
                value={match.side_b_value}
              />
            </>
          )}
          <Row label="Difference" value={match.difference} />
          <Row label="Tolerance" value={match.tolerance} />
        </dl>
      ) : (
        <p className="rc-mono text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
          The comparison detail was not recorded for this case. It cleared
          deterministically
          {category ? ` as ${category}` : ""}, but the values Tier-1 compared
          were not persisted at the time — only cases cleared after that
          attribute was added carry them.
        </p>
      )}

      {match?.ledger_row && (
        <div className="space-y-1">
          <Eyebrow>Matched Ledger Row</Eyebrow>
          <dl className="rc-mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            {Object.entries(match.ledger_row).map(([k, v]) => (
              <Row key={k} label={k} value={v} />
            ))}
          </dl>
        </div>
      )}

      {(match?.ledger_rows_returned || match?.candidates_considered) && (
        <p className="rc-mono text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
          Exactly one of {match.ledger_rows_returned ?? "?"} ledger rows
          returned for this borrower satisfied all three filters, against{" "}
          {match.candidates_considered ?? "?"} amounts extracted from the
          document. A unique survivor is what makes this deterministic — two
          would have escalated to the agent instead.
        </p>
      )}
    </Panel>
  );
}

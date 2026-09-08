/**
 * The Matched Notices panel reads its rows out of the trace rather than from a route, so the parse
 * is the part that can silently go wrong: `tool_output` is an untyped string, and a denied tool call
 * puts an error object where the rows would be. Every case below is one shape a real trace produces.
 *
 * The distinction the tests care about most is "searched and found nothing" versus "never searched".
 * Collapsing them would make a harness-produced case — which records no `search_notices` call at all
 * — claim that the notice search came back empty, which is a statement about evidence that was never
 * gathered.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReasoningStep } from "@/lib/reconApi";
import {
  MatchedNoticesPanel,
  noticesFromTrace,
} from "@/components/recon/MatchedNoticesPanel";

// The preview fetches bytes with an auth header and hands them to an <iframe> as an object URL.
// Stubbed because jsdom has neither; what these tests care about is that the expanded row RENDERS
// it, keyed by the notice's own source_document, not how it streams.
vi.mock("@/components/recon/SourceDocumentPreview", () => ({
  default: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="source-preview">preview:{objectKey}</div>
  ),
}));

/** A `search_notices` tool_call step carrying the given JSON payload verbatim. */
function noticeCall(payload: unknown): ReasoningStep {
  return {
    skill: "search_notices",
    confidence: "0.9",
    reasoning: "",
    evidence: [],
    kind: "tool_call",
    tool: "search_notices",
    tool_output: JSON.stringify(payload),
  } as ReasoningStep;
}

const ROW = {
  notice_id: "NTC-20260302-0001",
  notice_class: "wire_confirmation",
  notice_date: "2026-03-02",
  counterparty: "CINDERMOOR LOGISTICS HOLDINGS INC.",
  fund: "Direct Lending Fund I",
  facility: "CINDERMOOR LOGISTICS TL-A $160MM",
  reference: "WIRE-20260302-EVG",
  amount: 9640.18,
  currency: "USD",
  extraction_confidence: 0.94,
  confidence_alert_count: 0,
  source_document: "Paydown_and_Interest_Notice.pdf",
  fields_unavailable: [],
};

describe("noticesFromTrace", () => {
  it("distinguishes a search that found nothing from no search at all", () => {
    expect(noticesFromTrace(undefined).searched).toBe(false);
    expect(
      noticesFromTrace([noticeCall({ rows: [], matched_on: ["amount"] })])
        .searched,
    ).toBe(true);
  });

  it("de-duplicates a notice the agent matched on more than one call", () => {
    // The agent narrows by calling search_notices repeatedly; the same notice returning twice is one
    // piece of evidence, and listing it twice would overstate what was found.
    const out = noticesFromTrace([
      noticeCall({ rows: [ROW], matched_on: ["amount"] }),
      noticeCall({ rows: [ROW], matched_on: ["reference"] }),
    ]);
    expect(out.notices).toHaveLength(1);
    expect(out.matchedOn).toEqual(["amount", "reference"]);
  });

  it("keeps rows that carry no notice_id rather than dropping them", () => {
    // Such a row cannot be de-duplicated, but it is still evidence the agent saw.
    const out = noticesFromTrace([
      noticeCall({ rows: [{ counterparty: "A" }, { counterparty: "B" }] }),
    ]);
    expect(out.notices).toHaveLength(2);
  });

  it("survives a tool_output that is not JSON", () => {
    const broken = {
      ...noticeCall({}),
      tool_output: "AccessDenied: not JSON at all",
    } as ReasoningStep;
    // searched is still true: the call happened. It simply contributed no rows.
    const out = noticesFromTrace([broken]);
    expect(out.searched).toBe(true);
    expect(out.notices).toEqual([]);
  });

  it("reports a tool-level error instead of treating it as an empty match", () => {
    const out = noticesFromTrace([noticeCall({ error: "ToolDenied: nope" })]);
    expect(out.error).toBe("ToolDenied: nope");
    expect(out.notices).toEqual([]);
  });

  it("ignores tool calls that are not search_notices", () => {
    const ledger = {
      ...noticeCall({ rows: [ROW] }),
      tool: "search_ledger",
    } as ReasoningStep;
    expect(noticesFromTrace([ledger]).searched).toBe(false);
  });
});

describe("MatchedNoticesPanel", () => {
  it("renders nothing when the trace records no notice search", () => {
    const { container } = render(<MatchedNoticesPanel steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the search matched nothing, and ties that to the evidence steps", () => {
    render(
      <MatchedNoticesPanel
        steps={[noticeCall({ rows: [], matched_on: ["amount"] })]}
      />,
    );
    expect(screen.getByText(/matched no notices/)).toBeTruthy();
    // The panel exists to explain the score, so it must make the link explicit.
    expect(screen.getByText(/returned\s+nothing/)).toBeTruthy();
  });

  it("lists a matched notice collapsed, and expands it to every field on click", () => {
    render(<MatchedNoticesPanel steps={[noticeCall({ rows: [ROW] })]} />);

    // Collapsed: the identifying summary is visible, the detail is not.
    expect(screen.getByText("NTC-20260302-0001")).toBeTruthy();
    expect(screen.getByText("wire_confirmation")).toBeTruthy();
    expect(screen.queryByText("Paydown_and_Interest_Notice.pdf")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText("Paydown_and_Interest_Notice.pdf")).toBeTruthy();
    expect(screen.getByText("WIRE-20260302-EVG")).toBeTruthy();
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
  });

  it("surfaces a confidence alert count on the collapsed row", () => {
    // A reason to distrust the row's own numbers has to be visible BEFORE deciding to expand it.
    render(
      <MatchedNoticesPanel
        steps={[noticeCall({ rows: [{ ...ROW, confidence_alert_count: 3 }] })]}
      />,
    );
    expect(screen.getByText("3 alerts")).toBeTruthy();
  });

  it("renders an unlisted field the tool starts returning", () => {
    // FIELD_ORDER is a reading order, not an allowlist: a new upstream field must not vanish.
    render(
      <MatchedNoticesPanel
        steps={[noticeCall({ rows: [{ ...ROW, novel_field: "kept" }] })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("kept")).toBeTruthy();
    // Rendered under its humanized label, after the listed fields.
    expect(screen.getByText("novel field")).toBeTruthy();
  });

  it("shows the source document beside the fields, keyed by the notice's own source_document", () => {
    // The analyst's doubt is "is amount really 9,640.18?", and that is answered by the page the value
    // was read off -- not by the row restating it. So the document sits next to the fields.
    render(<MatchedNoticesPanel steps={[noticeCall({ rows: [ROW] })]} />);
    expect(screen.queryByTestId("source-preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByTestId("source-preview").textContent).toBe(
      "preview:Paydown_and_Interest_Notice.pdf",
    );
  });

  it("says so plainly when a notice records no source document", () => {
    // A rollover notice or a hand-seeded row may carry none. An empty frame would read as a broken
    // preview, so the absence is stated instead.
    const { source_document: _drop, ...noSource } = ROW;
    render(<MatchedNoticesPanel steps={[noticeCall({ rows: [noSource] })]} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.queryByTestId("source-preview")).toBeNull();
    expect(screen.getByText(/records no source document/)).toBeTruthy();
  });
});

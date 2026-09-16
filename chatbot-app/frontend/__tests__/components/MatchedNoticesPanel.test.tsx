/**
 * The Matched Notices panel takes its rows from the case's persisted `notice_search` when it has one,
 * and from the trace otherwise. Both sources are covered here.
 *
 * The distinctions the tests care about most are the three ways this panel can have no rows to show,
 * because they lead an analyst to opposite conclusions and two of them are easy to conflate:
 *   - never searched          → render nothing (a harness-produced case gathered no notice evidence);
 *   - searched, matched none  → "matched no notices", which explains the evidence score;
 *   - searched, unreadable    → say the rows cannot be read. NOT "matched no notices".
 *
 * That last case is the subtle one: the trace's `tool_output` is capped at 600 characters and a single
 * notice row is larger, so a panel that parses the fragment and swallows the failure reports an empty
 * match on cases whose evidence table cites five notices by id.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NoticeSearch, ReasoningStep } from "@/lib/reconApi";
import {
  MatchedNoticesPanel,
  noticesFromTrace,
  resolveNoticeSearch,
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

// One row exactly as `search_notices` returns it: the index keys and recon's bookkeeping as attributes,
// and everything the extractor read inside `idp_sections[].fields` as the STRINGS it emitted. The panel
// has to flatten that itself, so a fixture that put the extracted fields at the top level would test a
// shape the tool never produces.
const ROW = {
  notice_id: "NTC-20260302-0001",
  notice_class: "wire_confirmation",
  notice_date: "2026-03-02",
  counterparty: "CINDERMOOR LOGISTICS HOLDINGS INC.",
  reference: "WIRE-20260302-EVG",
  idp_sections: [
    {
      section_id: "1",
      classification: "wire_confirmation",
      fields: {
        fund: "Direct Lending Fund I",
        facility: "CINDERMOOR LOGISTICS TL-A $160MM",
        amount: "9640.18",
        currency: "USD",
        cusip: "12345AB6",
      },
    },
  ],
  extraction_confidence: 0.94,
  confidence_alert_count: 0,
  source_document: "Paydown_and_Interest_Notice.pdf",
  fields_unavailable: [],
};

/** A `search_notices` step whose output was cut at 600 chars, exactly as the trace stores it. */
function truncatedNoticeCall(): ReasoningStep {
  const full = JSON.stringify({
    rows: [{ ...ROW, notes: "z".repeat(800) }],
    matched_on: ["amount"],
  });
  return {
    ...noticeCall({}),
    tool_output: full.slice(0, 600),
  } as ReasoningStep;
}

/** A persisted `notice_search` attribute, as the agent now writes it. */
function persisted(overrides: Partial<NoticeSearch> = {}): NoticeSearch {
  return {
    searched: true,
    rows: [ROW],
    matched_on: ["amount"],
    error: null,
    omitted: 0,
    ...overrides,
  };
}

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

  it("survives a tool_output that is not JSON, and flags it as unreadable", () => {
    const broken = {
      ...noticeCall({}),
      tool_output: "AccessDenied: not JSON at all",
    } as ReasoningStep;
    // searched is still true: the call happened. It contributed no rows AND could not be read —
    // which the panel must report differently from a search that matched nothing.
    const out = noticesFromTrace([broken]);
    expect(out.searched).toBe(true);
    expect(out.notices).toEqual([]);
    expect(out.unreadable).toBe(true);
  });

  it("flags the 600-char truncation rather than reporting an empty match", () => {
    // The exact regression: a real row is larger than the trace's cap, so the stored output is a JSON
    // fragment. Reporting this as "no notices" contradicted the evidence table on the same screen.
    const out = noticesFromTrace([truncatedNoticeCall()]);
    expect(out.searched).toBe(true);
    expect(out.notices).toEqual([]);
    expect(out.unreadable).toBe(true);
  });

  it("does not flag a readable, genuinely empty result as unreadable", () => {
    const out = noticesFromTrace([noticeCall({ rows: [] })]);
    expect(out.unreadable).toBe(false);
  });
});

describe("resolveNoticeSearch", () => {
  it("prefers the persisted rows over the trace", () => {
    // The persisted rows are the agent's own untruncated record. When both exist the trace is ignored
    // outright rather than merged — a row one source lost would otherwise appear beside one it kept.
    const out = resolveNoticeSearch({
      noticeSearch: persisted({ rows: [ROW, { notice_id: "NTC-2" }] }),
      steps: [truncatedNoticeCall()],
    });
    expect(out.notices).toHaveLength(2);
    expect(out.unreadable).toBe(false);
  });

  it("falls back to the trace when the case has no persisted rows", () => {
    const out = resolveNoticeSearch({
      noticeSearch: null,
      steps: [noticeCall({ rows: [ROW], matched_on: ["amount"] })],
    });
    expect(out.notices).toHaveLength(1);
    expect(out.matchedOn).toEqual(["amount"]);
  });

  it("carries the persisted omitted count through", () => {
    const out = resolveNoticeSearch({
      noticeSearch: persisted({ omitted: 4 }),
      steps: undefined,
    });
    expect(out.omitted).toBe(4);
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

  it("lists the persisted notices, ignoring a truncated trace on the same case", () => {
    render(
      <MatchedNoticesPanel
        noticeSearch={persisted({
          rows: [ROW, { notice_id: "NTC-2", notice_class: "paydown_notice" }],
        })}
        steps={[truncatedNoticeCall()]}
      />,
    );

    expect(screen.getByText("Matched Notices (2)")).toBeTruthy();
    expect(screen.getByText("NTC-20260302-0001")).toBeTruthy();
    expect(screen.getByText("NTC-2")).toBeTruthy();
    expect(screen.queryByText(/matched no notices/)).toBeNull();
  });

  it("says the rows cannot be read, not that none matched, on a truncated old case", () => {
    render(<MatchedNoticesPanel steps={[truncatedNoticeCall()]} />);

    expect(screen.getByText(/cannot be shown/)).toBeTruthy();
    // The claim that broke trust in the panel must not appear.
    expect(screen.queryByText(/matched no notices/)).toBeNull();
    // And it must say the evidence table above is still sound.
    expect(screen.getByText(/evidence table is unaffected/)).toBeTruthy();
  });

  it("names how many matched notices are not shown when the store capped them", () => {
    render(
      <MatchedNoticesPanel
        noticeSearch={persisted({ omitted: 7 })}
        steps={undefined}
      />,
    );
    expect(
      screen.getByText(/7 further matched notices are not shown/),
    ).toBeTruthy();
  });

  it("renders extracted fields flattened out of idp_sections", () => {
    // Extracted content is not a top-level attribute -- only the index keys are -- so a panel that read
    // the row directly would show the notice's identity and none of its content.
    render(
      <MatchedNoticesPanel noticeSearch={persisted({})} steps={undefined} />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText("Direct Lending Fund I")).toBeTruthy();
    expect(screen.getByText("12345AB6")).toBeTruthy();
    // And the container itself is not rendered beside them: that would print every value twice, the
    // second time as a JSON blob.
    expect(screen.queryByText(/Idp Sections/)).toBeNull();
  });

  it("formats the summary amount from the extracted string, with its currency", () => {
    render(
      <MatchedNoticesPanel noticeSearch={persisted({})} steps={undefined} />,
    );
    expect(screen.getByText("USD 9,640.18")).toBeTruthy();
  });

  it("shows no summary amount when the extracted value is not a number", () => {
    // A malformed amount reaches the table rather than dead-lettering the document, so the panel has to
    // cope with one. Omitting the summary figure is right: the expanded view still shows it verbatim,
    // and a NaN or a silently-zeroed figure beside a counterparty would be read as the real amount.
    const row = {
      ...ROW,
      idp_sections: [{ section_id: "1", fields: { amount: "n/a" } }],
    };
    render(
      <MatchedNoticesPanel
        noticeSearch={{ ...persisted({}), rows: [row] } as NoticeSearch}
        steps={undefined}
      />,
    );
    expect(screen.queryByText(/9,640.18/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});

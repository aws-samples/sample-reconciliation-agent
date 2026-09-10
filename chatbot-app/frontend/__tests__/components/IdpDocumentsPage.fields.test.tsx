/**
 * The Documents tab's extracted-field columns, and the detail panel beside the source file.
 *
 * The pipeline's own tracking columns — statuses, times, a page count — cannot answer the one question
 * an operator opens this tab for: "what did the extractor actually read out of this notice". Those
 * values are not in the rows the table already has; they are embedded on recon's own notice row, one
 * lookup per document to reach.
 *
 * That cost is what shapes the tests below. The read happens on its own now — the button that used to
 * trigger it is gone, along with the rest of the strip under the table — but it is still a read that lands
 * after the rows do, so the tab has THREE states per cell and an operator who cannot tell them apart is
 * worse off than before:
 *
 *   - not read yet (a middle dot),
 *   - read, and this document has no section of that class (an em dash),
 *   - read, with a value and the confidence it was read at.
 *
 * And a document whose result could not be read at all has to be NAMED. Left silent it shows middle
 * dots in every column, which is indistinguishable from a read that has not happened yet.
 *
 * The other half of this file is the FILTER, which is now the tab's only configuration restriction: the
 * pinned versions are seeded into the box, and clearing the box shows every loaded row. Two properties
 * there are load-bearing enough to have their own tests — that a row with NO version stays visible while
 * a FOREIGN one is hidden, and that clearing the box really does reveal everything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type { ExtractedSection, IdpDocument } from "@/lib/reconApi";

const listIdpDocuments = vi.fn();
const getIdpDocument = vi.fn();
const getIdpExtraction = vi.fn();
const getIdpExtractions = vi.fn();
const listSubmissions = vi.fn();
const listWorkflowTypes = vi.fn();

vi.mock("@/lib/reconApi", () => ({
  listIdpDocuments: (...a: unknown[]) => listIdpDocuments(...a),
  getIdpDocument: (...a: unknown[]) => getIdpDocument(...a),
  getIdpExtraction: (...a: unknown[]) => getIdpExtraction(...a),
  getIdpExtractions: (...a: unknown[]) => getIdpExtractions(...a),
  listSubmissions: (...a: unknown[]) => listSubmissions(...a),
  listWorkflowTypes: (...a: unknown[]) => listWorkflowTypes(...a),
}));
vi.mock("@/hooks/useReconSubject", () => ({
  useReconSubject: () => ({ subject: "", isAdmin: false }),
}));
// The preview renders a PDF through an object URL, which jsdom has no view of. Stubbed to a marker so
// the layout assertion below can still say the file and the fields are on screen together.
vi.mock("@/components/recon/SourceDocumentPreview", () => ({
  default: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="source-preview">{objectKey}</div>
  ),
}));
vi.mock("@/components/recon/UploadDialog", () => ({
  UploadDialog: () => null,
}));

import IdpDocumentsPage from "@/app/recon/idp-documents/page";
// The real mapper, NOT mocked. The rows this tab renders are whatever it produces, and the two bugs the
// backfilled rows had were one on each side of it: the mapper returned no start time, and the page then
// filtered the row out entirely. Driving the page's fixtures through it is what ties the halves together.
import { toIdpDocument, type DocumentRow } from "@/lib/idpDocumentStore";

/** A processed row against the configuration this deployment pins. */
function doc(objectKey: string): IdpDocument {
  return {
    ObjectKey: objectKey,
    ObjectStatus: "COMPLETED",
    WorkflowStatus: "SUCCEEDED",
    ConfigVersion: "Recon-IDP",
    InitialEventTime: "2026-09-07T10:00:00Z",
    CompletionTime: "2026-09-07T10:01:00Z",
    PageCount: 2,
    ConfidenceAlertCount: 1,
    EvaluationStatus: null,
    QueuedTime: null,
  } as unknown as IdpDocument;
}

/**
 * One BACKFILLED row, exactly as it is stored: the index attributes and no `idp_tracking` at all.
 *
 * 16 of these are live. `scripts/backfill_idp_document_index.py` put recon's pre-existing notices into
 * this tab's index so the history before the tracking snapshot would be visible, and a snapshot is the
 * one thing it could not invent — hence no version, no statuses, and a start time derived from the
 * notice's own business date.
 *
 * @param objectKey - the document's key.
 */
function backfilledRow(objectKey: string): DocumentRow {
  return {
    notice_id: `idp-${objectKey}`,
    record_kind: "notice",
    source_document: objectKey,
    parse_method: "IDP",
    idp_started_at: "2026-03-04T00:00:00Z",
    idp_started_at_approximate: true,
  };
}

/** One paydown-notice section: a clean name and a table row scored below its own threshold. */
function sections(): ExtractedSection[] {
  return [
    {
      section_id: "1",
      classification: "paydown_notice",
      page_ids: [1],
      fields: {
        BorrowerName: "Cascade Holdings LLC",
        PaydownAmount: "1,250,000.00",
      },
      confidences: [
        {
          field: "BorrowerName",
          confidence: 0.99,
          threshold: 0.8,
          extracted: true,
        },
        {
          field: "PaydownAmount",
          confidence: 0.55,
          threshold: 0.9,
          extracted: true,
        },
      ],
      mean_confidence: 0.77,
      alert_count: 1,
    },
  ];
}

/** The filter box, which arrives holding this deployment's pinned configuration versions. */
function filterInput(): HTMLInputElement {
  return screen.getByPlaceholderText(
    "file name, config version, workflow status",
  ) as HTMLInputElement;
}

/** Type into the filter box, as an operator would. `""` is the clear this change exists for. */
function typeFilter(value: string): void {
  fireEvent.change(filterInput(), { target: { value } });
}

/**
 * Flush the promises the tab kicked off, and the renders they cause.
 *
 * Every mock in this file resolves immediately, so this is enough to reach the settled state. It is what
 * an assertion about something NOT happening needs: `waitFor` on an absence passes before the thing it is
 * looking for has had a chance to appear.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/**
 * Render the tab and wait for its first page of rows AND for the pins to have reached the filter box.
 *
 * Waiting for the seed is what makes an assertion about a HIDDEN row mean anything: the pins are their own
 * request, and until they land the box is empty and every loaded row is on screen.
 *
 * @param seed - the value the box is expected to be seeded with.
 */
async function renderTab(seed = "Recon-IDP") {
  render(<IdpDocumentsPage />);
  await waitFor(() => expect(screen.getByText("notice.pdf")).toBeTruthy());
  await waitFor(() => expect(filterInput().value).toBe(seed));
}

/** Wait for the tab to have read the extracted fields for the rows on screen, unasked. */
async function fieldsRead(): Promise<void> {
  await waitFor(() => expect(getIdpExtractions).toHaveBeenCalled());
  await settle();
}

/** Tick the picker entry whose label is `label`. */
function tick(label: string) {
  fireEvent.click(
    screen.getByText(label).closest("label")!.querySelector("input")!,
  );
}

describe("Documents tab extracted fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf")],
      nextToken: null,
    });
    listSubmissions.mockResolvedValue([]);
    // The tab shows only rows whose configuration version a workflow type pins.
    listWorkflowTypes.mockResolvedValue([
      { name: "paydown", route: "extraction", idp_config_version: "Recon-IDP" },
    ]);
    getIdpExtractions.mockResolvedValue({
      extractions: { "in/notice.pdf": sections() },
      failed: {},
    });
    getIdpExtraction.mockResolvedValue({
      sections: sections(),
      unavailable: null,
    });
    getIdpDocument.mockResolvedValue({
      ObjectKey: "in/notice.pdf",
      ObjectStatus: "COMPLETED",
      Sections: [],
    });
  });

  it("removes the strip under the table and does the work it did", async () => {
    // ⚠️ The strip is gone -- "Load more", "Load extracted fields", and the count line beside them -- and
    // the CAPABILITY is not. The buttons were the only way to reach either, and neither was discoverable:
    // an operator who did not press the second one saw a table of middle dots and no reason for them.
    await renderTab();
    await fieldsRead();

    for (const gone of [
      /Load more/,
      /All rows loaded/,
      /Load extracted fields/,
      /Extracted fields loaded/,
    ])
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    // Nor the count line that sat beside them.
    expect(screen.queryByText(/extracted-field column/)).toBeNull();
    expect(screen.queryByText(/1 loaded/)).toBeNull();

    // The read happened anyway, over exactly the rows on screen.
    expect(getIdpExtractions).toHaveBeenCalledWith(["in/notice.pdf"]);
  });

  it("offers one column per extracted field, read without being asked", async () => {
    await renderTab();
    await fieldsRead();
    expect(getIdpExtractions).toHaveBeenCalledWith(["in/notice.pdf"]);

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    // Namespaced by document class: the same field name means different things in a paydown notice and
    // in a wire confirmation, and one column holding both would put two figures under one header.
    expect(screen.getByText("paydown_notice · BorrowerName")).toBeTruthy();
    expect(screen.getByText("paydown_notice · PaydownAmount")).toBeTruthy();
  });

  it("shows the value and its confidence once a field column is switched on", async () => {
    await renderTab();
    await fieldsRead();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    tick("paydown_notice · PaydownAmount");

    await waitFor(() => expect(screen.getByText("1,250,000.00")).toBeTruthy());
    // The score sits under the value: a figure with no confidence beside it is the state this whole
    // feature exists to remove.
    const score = screen.getByText("0.55");
    expect(score.getAttribute("style")).toContain("var(--rc-amber)");
    expect(score.getAttribute("title")).toBe("threshold 0.90");
    // The other field was not asked for and stays off the row.
    expect(screen.queryByText("Cascade Holdings LLC")).toBeNull();
  });

  it("distinguishes a document with no section of that class from one not read yet", async () => {
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), doc("in/wire.pdf")],
      nextToken: null,
    });
    // Both keys read; the second carries a different class, so it has no paydown field to show.
    getIdpExtractions.mockResolvedValue({
      extractions: {
        "in/notice.pdf": sections(),
        "in/wire.pdf": [
          {
            section_id: "1",
            classification: "wire_confirmation",
            page_ids: [1],
            fields: { Amount: "500.00" },
            confidences: [],
            mean_confidence: null,
            alert_count: 0,
          },
        ],
      },
      failed: {},
    });
    await renderTab();
    await fieldsRead();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    tick("paydown_notice · BorrowerName");

    await waitFor(() =>
      expect(screen.getByText("Cascade Holdings LLC")).toBeTruthy(),
    );
    // An em dash, and a title that says why -- not the middle dot that means "press the button".
    expect(
      screen.getByTitle("This document has no paydown_notice section"),
    ).toBeTruthy();
  });

  it("names a document that has no extracted fields to show", async () => {
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), doc("in/expired.pdf")],
      nextToken: null,
    });
    getIdpExtractions.mockResolvedValue({
      extractions: { "in/notice.pdf": sections() },
      failed: {
        "in/expired.pdf": "the pipeline has no record of this document",
      },
    });
    await renderTab();
    await fieldsRead();

    // Named by file name, with the reason. Silently missing, this document would show middle dots in
    // every field column and look exactly like one nobody had loaded.
    // Not "could not be read": a reason in this block can also be that the document never became a
    // notice, in which case there was nothing to read.
    expect(
      screen.getByText(/1 document with no extracted fields to show/),
    ).toBeTruthy();
    // File name and reason in one line: `expired.pdf` alone also matches the row up in the table, and
    // what is worth asserting is that the row and its reason are connected.
    expect(
      screen.getByText(
        /expired\.pdf — the pipeline has no record of this document/,
      ),
    ).toBeTruthy();
  });

  it("leaves a tracking-only row out of the no-fields block, and counts what it lists", async () => {
    // A tracking-only row has no extracted fields because recon mapped NO NOTICE from the document --
    // an outcome the pipeline reached and recorded, already spelled out on that row's own detail panel
    // under "Extracted fields". Repeating it in amber here dressed an ordinary answer as a warning and
    // said it twice. What the block is FOR is the reasons a reader cannot get off the row.
    listIdpDocuments.mockResolvedValue({
      documents: [
        doc("in/notice.pdf"),
        // Carries the reason, so it is a tracking-only row: excluded.
        {
          ...doc("in/fax-cover.pdf"),
          notice_failure_reason: "extracted no notice_date/value_date",
        },
        doc("in/expired.pdf"),
      ],
      nextToken: null,
    });
    getIdpExtractions.mockResolvedValue({
      extractions: { "in/notice.pdf": sections() },
      failed: {
        "in/fax-cover.pdf":
          "recon mapped no notice from this document: extracted no notice_date/value_date",
        "in/expired.pdf": "recon has no notice for this document",
      },
    });
    await renderTab();
    await fieldsRead();

    // ONE, not two. The count is read off the same list the entries are, so a summary line promising a
    // document the block does not list is not expressible.
    expect(
      screen.getByText(/1 document with no extracted fields to show/),
    ).toBeTruthy();
    expect(
      screen.getByText(/expired\.pdf — recon has no notice for this document/),
    ).toBeTruthy();
    // The tracking-only row's reason is not repeated here.
    expect(screen.queryByText(/fax-cover\.pdf — recon mapped no notice/)).toBe(
      null,
    );
  });

  it("renders no block at all when every failure is a tracking-only row", async () => {
    // Not an empty `<details>`: a disclosure that opens onto nothing reads as a warning whose detail is
    // being withheld.
    listIdpDocuments.mockResolvedValue({
      documents: [
        doc("in/notice.pdf"),
        {
          ...doc("in/fax-cover.pdf"),
          notice_failure_reason: "extracted no notice_date/value_date",
        },
      ],
      nextToken: null,
    });
    getIdpExtractions.mockResolvedValue({
      extractions: { "in/notice.pdf": sections() },
      failed: {
        "in/fax-cover.pdf":
          "recon mapped no notice from this document: extracted no notice_date/value_date",
      },
    });
    await renderTab();
    await fieldsRead();

    expect(screen.queryByText(/with no extracted fields to show/)).toBeNull();
    expect(screen.queryByText(/0 documents/)).toBeNull();
  });

  it("shows no object status, which is EVALUATING on every row it records", async () => {
    // Recon's hook fires while the pipeline is still evaluating, so `ObjectStatus` is `EVALUATING` on
    // every row in the live table -- a constant, and one that read as a contradiction beside the two
    // TERMINAL statuses the same row carries (`SUCCEEDED` and `COMPLETED`). It is still on the wire
    // contract and still stored; it is only not displayed.
    listIdpDocuments.mockResolvedValue({
      documents: [{ ...doc("in/notice.pdf"), ObjectStatus: "EVALUATING" }],
      nextToken: null,
    });
    await renderTab();

    expect(screen.queryByText("EVALUATING")).toBeNull();
    // Nor a hidden column in the picker to switch it back on. The picker's other entries prove the
    // assertion is not vacuous.
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();

    // And gone from the detail panel's grid, where the same three statuses sat side by side.
    fireEvent.click(screen.getByText("notice.pdf"));
    await waitFor(() =>
      expect(screen.getByText("Workflow status")).toBeTruthy(),
    );
    expect(screen.queryByText("Object status")).toBeNull();
  });

  it("says so when the whole read failed, and does not retry it for ever", async () => {
    // ⚠️ The runaway-loop guard, and the case that makes it necessary. A rejected call records nothing per
    // key, so the key stays in the unloaded set -- which is the very thing the auto-load effect watches.
    // Without the requested-keys ledger this would re-fire on every render for as long as the tab stayed
    // open, hammering the route behind an error message nobody could act on.
    getIdpExtractions.mockRejectedValue(new Error("signing failed"));
    await renderTab();

    await waitFor(() =>
      expect(
        screen.getByText(/Could not read extracted fields — .*signing failed/),
      ).toBeTruthy(),
    );
    // Once. Not once per render.
    expect(getIdpExtractions).toHaveBeenCalledTimes(1);
    // And re-rendering the table over the same rows -- which is what typing in the filter box does -- does
    // not talk the effect into trying again.
    typeFilter("notice");
    await settle();
    expect(getIdpExtractions).toHaveBeenCalledTimes(1);

    // Apply is the escape hatch, and the only one: the effect never retries on its own, so without a
    // gesture that releases the ledger a whole-call failure would be permanent for the session.
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await settle();
    expect(getIdpExtractions).toHaveBeenCalledTimes(2);
  });

  it("shows the extracted fields beside the source file when a row is opened", async () => {
    await renderTab();
    fireEvent.click(screen.getByText("notice.pdf"));

    // Both halves of the comparison on screen at once: the page on the left, and every field the
    // extractor read with its score on the right.
    await waitFor(() =>
      expect(screen.getByTestId("source-preview")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByText("Cascade Holdings LLC")).toBeTruthy(),
    );
    expect(screen.getByText("1,250,000.00")).toBeTruthy();
    expect(screen.getByText("0.99")).toBeTruthy();
    expect(screen.getByText("0.55")).toBeTruthy();
    expect(getIdpExtraction).toHaveBeenCalledWith("in/notice.pdf");
  });

  it("says what the flagged list includes, and what the Alerts count leaves out", async () => {
    // Two numbers on this tab count different things and BOTH are correct. The Alerts column is recon's
    // `confidence_alert_count`, which `below_threshold_count` in
    // `backend/idp_hook/explainability.py` computes over the fields the extractor READ A VALUE FOR;
    // the panel lists the pipeline's raw flags, which include attributes it found nothing for and which
    // arrive as `0.00` against a `0.80` threshold. Live that is 0 in the column against up to 2 entries
    // in the panel. Neither side can be redefined to agree -- recon's number is the one the gateway
    // interceptor refuses ledger writes on -- so the difference is explained on screen, and this test is
    // what stops the explanation quietly disappearing.
    getIdpDocument.mockResolvedValue({
      ObjectKey: "in/notice.pdf",
      ConfidenceAlertCount: 0,
      Sections: [
        {
          Id: "1",
          Class: "agent_notice",
          PageIds: [1],
          ConfidenceThresholdAlerts: [
            {
              attributeName: "agent_telephone",
              confidence: 0,
              confidenceThreshold: 0.8,
            },
          ],
        },
      ],
    });
    await renderTab();
    fireEvent.click(screen.getByText("notice.pdf"));

    // The heading no longer calls the whole list "confidence alerts", because an attribute with no value
    // was never a confidence anybody measured.
    await waitFor(() =>
      expect(
        screen.getByText(/Sections and every attribute the pipeline flagged/),
      ).toBeTruthy(),
    );
    // The entry the wording is about, exactly as it reads on screen.
    expect(screen.getByText(/agent_telephone — 0.00 below 0.80/)).toBeTruthy();
    // And the sentence that reconciles the two numbers, beside the entry it explains rather than in a
    // tooltip on a heading nobody hovers.
    expect(
      screen.getByText(/read no value for that attribute at all/),
    ).toBeTruthy();
    expect(
      screen.getByText(/counts only attributes it did extract/),
    ).toBeTruthy();
  });

  it("says on the Alerts column itself what that count leaves out", async () => {
    await renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    // Hidden by default, and the picker labels it by column id: the header is a node carrying the
    // tooltip, which is the same trade the Eval column makes.
    tick("alerts");

    const marks = await waitFor(() =>
      screen.getAllByTitle(/^Counts only attributes the extractor read/),
    );
    // On the header AND on the cell. The header is where a reader looks for what a column means; the cell
    // is what they hover when the number disagrees with the detail panel they just closed.
    expect(marks.map((m) => m.textContent)).toEqual(["Alerts", "1"]);
  });

  it("still shows the extracted fields when the tracking record will not load", async () => {
    // Two independent fetches. The record the tab was built around failing must not take the half an
    // operator actually came for with it.
    getIdpDocument.mockRejectedValue(new Error("api down"));
    await renderTab();
    fireEvent.click(screen.getByText("notice.pdf"));

    await waitFor(() =>
      expect(screen.getByText(/Failed to load document/)).toBeTruthy(),
    );
    expect(screen.getByText("Cascade Holdings LLC")).toBeTruthy();
  });

  it("names why there are no extracted fields instead of showing a failure", async () => {
    // Recon holds no notice for the document -- an unmapped class, or no readable notice date. That is
    // an ordinary outcome, so it must not arrive under the red banner the two tests above assert on:
    // an operator sent to look for a broken console will not find one.
    getIdpExtraction.mockResolvedValue({
      sections: [],
      unavailable: "recon holds no notice for this document",
    });
    await renderTab();
    fireEvent.click(screen.getByText("notice.pdf"));

    await waitFor(() =>
      expect(screen.getByText(/recon holds no notice/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Failed to read what was extracted/)).toBeNull();
  });

  it("marks a start time it had to guess, and marks only that one", async () => {
    // Most of the history carries a derived time: the backfill that put the pre-existing rows into this
    // tab's index had no ingest timestamp and used the notice's own business date. Those dates scatter
    // across the year, so in a wide window a guessed row sorts among genuinely recent ones -- and the
    // Started column sorts. A tooltip alone would leave a reader ordering by it none the wiser, which is
    // why the marker has to be ON the row.
    const guessed = {
      ...doc("in/backfilled.pdf"),
      idp_started_at_approximate: true,
    };
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), guessed],
      nextToken: null,
    });
    await renderTab();

    const marks = screen.getAllByTitle(/^Approximate\./);
    // One marker, not two: a row whose time recon actually observed must not be tarred with it.
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("≈");
    // Amber rather than the body colour, so it reads as a caveat at a glance.
    expect(marks[0].className).toContain("var(--rc-amber)");
    // And the marker is explained. The header paragraph used to carry that legend and no longer does, so
    // this tooltip is the ONLY explanation the `≈` has — asserted on its CONTENT rather than just on the
    // title existing, and on the element that holds the glyph itself, which is the only thing a reader
    // would think to hover.
    expect(marks[0].getAttribute("title")).toMatch(
      /derived from the notice's own date/,
    );
  });

  it("shows a row it recorded no config version for, and hides another deployment's", async () => {
    // ⚠️ THE filter assertion, and it is two statements that only mean something together. An ABSENT
    // configuration version is not a FOREIGN one: the pipeline records what it ran, so a document
    // processed against another deployment's configuration always carries a NAME, and null happens only
    // where no snapshot was ever captured — recon's own pre-change rows. Filtering on the pinned set
    // alone hid all 16 of them, which is precisely what the backfill existed to prevent.
    const backfilled = toIdpDocument(backfilledRow("in/backfilled.pdf"));
    const foreign = {
      ...doc("in/foreign.pdf"),
      ConfigVersion: "slim15-assess-no-granular",
    };
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), backfilled, foreign],
      nextToken: null,
    });
    await renderTab();

    // ⚠️ And it holds with the pin SEEDED INTO THE BOX rather than applied invisibly, which is the way
    // this could regress now: a filter term that only compared versions would hide all 16 unversioned rows
    // the moment the seed landed, and the symptom would be a shorter table and nothing else.
    expect(filterInput().value).toBe("Recon-IDP");
    // Included: no version to check against the pins is not grounds for hiding recon's own history.
    expect(screen.getByText("backfilled.pdf")).toBeTruthy();
    // Still excluded: a version recon does not pin belongs to whoever queued it.
    expect(screen.queryByText("foreign.pdf")).toBeNull();
    // The prose that used to make these claims under the filter row is gone; the box says it instead.
    expect(
      screen.queryByText(/belongs to another configuration and is hidden/),
    ).toBeNull();
    expect(
      screen.queryByText(/pinned by the workflow types on the Config tab/),
    ).toBeNull();
  });

  it("reveals every loaded row when the filter is cleared", async () => {
    // ⚠️ THE point of putting the restriction in the box. It used to be unconditional: a document an
    // operator knew had been processed was simply absent, with a paragraph of prose as the only clue and
    // nothing to do about it. Clearing the box is the way out, so it has to actually produce the rows the
    // seeded pin was keeping off the table.
    const foreign = {
      ...doc("in/foreign.pdf"),
      ConfigVersion: "slim15-assess-no-granular",
    };
    const backfilled = toIdpDocument(backfilledRow("in/backfilled.pdf"));
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), backfilled, foreign],
      nextToken: null,
    });
    await renderTab();
    expect(screen.queryByText("foreign.pdf")).toBeNull();

    typeFilter("");

    // All three, including the one no pin covers.
    await waitFor(() => expect(screen.getByText("foreign.pdf")).toBeTruthy());
    expect(screen.getByText("notice.pdf")).toBeTruthy();
    expect(screen.getByText("backfilled.pdf")).toBeTruthy();
    // And it stays cleared: the seed must not put the pin back over the gesture it exists to allow.
    await settle();
    expect(filterInput().value).toBe("");
    expect(screen.getByText("foreign.pdf")).toBeTruthy();
  });

  it("still searches a file name when a term is not a pinned version", async () => {
    // The box is a filter first. Seeding it must not turn it into a version picker -- a term that matches
    // no pin is free text over the fields a reader can see, as it always was.
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/paydown-notice.pdf"), doc("in/wire.pdf")],
      nextToken: null,
    });
    render(<IdpDocumentsPage />);
    await waitFor(() =>
      expect(screen.getByText("paydown-notice.pdf")).toBeTruthy(),
    );

    typeFilter("paydown");

    await waitFor(() => expect(screen.queryByText("wire.pdf")).toBeNull());
    expect(screen.getByText("paydown-notice.pdf")).toBeTruthy();
  });

  it("does not overwrite a term typed while the pins were still loading", async () => {
    // The pins are their own request and the box is usable the moment it renders, so a seed that did not
    // check would eat whatever was typed in between -- and it would look like the input dropping
    // keystrokes, not like a filter being applied.
    let releasePins: (types: unknown[]) => void = () => {};
    listWorkflowTypes.mockReturnValue(
      new Promise((resolve) => {
        releasePins = resolve as (types: unknown[]) => void;
      }),
    );
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), doc("in/wire.pdf")],
      nextToken: null,
    });
    render(<IdpDocumentsPage />);
    await waitFor(() => expect(screen.getByText("notice.pdf")).toBeTruthy());

    typeFilter("wire");
    await act(async () => {
      releasePins([
        {
          name: "paydown",
          route: "extraction",
          idp_config_version: "Recon-IDP",
        },
      ]);
    });
    await settle();

    // What the operator typed, not the pin that arrived afterwards.
    expect(filterInput().value).toBe("wire");
    expect(screen.getByText("wire.pdf")).toBeTruthy();
    expect(screen.queryByText("notice.pdf")).toBeNull();
  });

  it("matches a row against every pinned version, not just the first", async () => {
    // ⚠️ Why this test exists: the filter is a SET-MEMBERSHIP test over every version the Config tab
    // pins, and a regression to single-value equality — `configKey(r) === [...pinnedLower][0]` — would
    // still pass every OTHER test in this file, because they all stub exactly one pinned version, which
    // is also all this deployment pins live today. The second pin is the case under test, and the
    // assertions below only mean something together: one pin matching proves nothing about the set.
    listWorkflowTypes.mockResolvedValue([
      { name: "paydown", route: "extraction", idp_config_version: "Recon-IDP" },
      {
        name: "paydown-v2",
        route: "extraction",
        idp_config_version: "Recon-IDP-v2",
      },
      // Contributes no pin: no version to pin, so it must not widen or narrow the set.
      { name: "kb", route: "knowledge-base", idp_config_version: "" },
    ]);
    // Lower case against the SECOND pin: the pin is hand-typed, so the casing has to be forgiven for
    // every pin and not only whichever one an equality test happened to keep.
    const secondPin = {
      ...doc("in/second.pdf"),
      ConfigVersion: "recon-idp-v2",
    };
    // A real foreign version out of this deployment's table, pinned by nobody here.
    const foreign = {
      ...doc("in/foreign.pdf"),
      ConfigVersion: "slim15-assess-no-granular",
    };
    const backfilled = toIdpDocument(backfilledRow("in/backfilled.pdf"));
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), secondPin, foreign, backfilled],
      nextToken: null,
    });
    // Both pins, comma-separated, in the box: the caption that used to list them is gone, and this is now
    // the only place an operator whose document ran under either can see that both are in force.
    await renderTab("Recon-IDP, Recon-IDP-v2");

    // Both pins match, not just the first one loaded.
    expect(screen.getByText("notice.pdf")).toBeTruthy();
    expect(screen.getByText("second.pdf")).toBeTruthy();
    // Neither pin covers this one, so it belongs to whoever queued it.
    expect(screen.queryByText("foreign.pdf")).toBeNull();
    // The unversioned row is still recon's own, marked unattributable rather than filtered out.
    expect(screen.getByText("backfilled.pdf")).toBeTruthy();
    const marks = screen.getAllByTitle(/^Recon recorded no configuration/);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("—?");
  });

  it("takes no pin from a workflow type that is not an extraction route", async () => {
    // A knowledge-base type's `idp_config_version` is not an extraction configuration: nothing on this
    // tab was processed under it, so it must not admit rows carrying that version.
    listWorkflowTypes.mockResolvedValue([
      { name: "paydown", route: "extraction", idp_config_version: "Recon-IDP" },
      { name: "kb", route: "knowledge-base", idp_config_version: "KB-Only" },
    ]);
    listIdpDocuments.mockResolvedValue({
      documents: [
        doc("in/notice.pdf"),
        { ...doc("in/kb.pdf"), ConfigVersion: "KB-Only" },
      ],
      nextToken: null,
    });
    await renderTab();

    expect(screen.queryByText("kb.pdf")).toBeNull();
    // Nor is it seeded into the box, which is the only place the pins are named now.
    expect(filterInput().value).toBe("Recon-IDP");
    expect(screen.queryByText(/KB-Only/)).toBeNull();
  });

  it("seeds nothing, and hides nothing, when no workflow type pins a version", async () => {
    // With no pins there is no term to seed, and an empty box is every loaded row. That is a CHANGE, and a
    // deliberate one: this used to leave only the unversioned rows on screen under a paragraph explaining
    // that no versioned row could be attributed to this deployment. Showing a versioned row nobody pinned
    // is the more honest of the two, because the box says out loud that nothing is being applied.
    listWorkflowTypes.mockResolvedValue([]);
    const backfilled = toIdpDocument(backfilledRow("in/backfilled.pdf"));
    listIdpDocuments.mockResolvedValue({
      documents: [backfilled, doc("in/notice.pdf")],
      nextToken: null,
    });
    render(<IdpDocumentsPage />);
    await waitFor(() =>
      expect(screen.getByText("backfilled.pdf")).toBeTruthy(),
    );
    await settle();

    expect(filterInput().value).toBe("");
    expect(screen.getByText("notice.pdf")).toBeTruthy();
    // And the prose that used to stand in for the empty box is gone.
    expect(
      screen.queryByText(
        /no versioned row can be attributed to this deployment/,
      ),
    ).toBeNull();
    expect(screen.queryByText(/Pin one on the Config tab/)).toBeNull();
  });

  it("marks the unknown provenance of a row it recorded no version for", async () => {
    const backfilled = toIdpDocument(backfilledRow("in/backfilled.pdf"));
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), backfilled],
      nextToken: null,
    });
    await renderTab();

    // One marker, on the one row that earns it: a row whose version WAS checked against the pins must
    // not be marked as unattributable.
    const marks = screen.getAllByTitle(/^Recon recorded no configuration/);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("—?");
    // Amber, like every other caveat in this table, so it reads as one at a glance.
    expect(marks[0].querySelector("span")!.className).toContain(
      "var(--rc-amber)",
    );
    // The tooltip says recon has no record rather than implying the row ran under nothing.
    expect(marks[0].getAttribute("title")).toMatch(
      /predates recon's tracking snapshot/,
    );
    // And it says which fact the `?` stands for. The header paragraph used to carry that legend and no
    // longer does, so this tooltip is the only explanation the marker has left — and the amber `?` a
    // reader would hover is INSIDE the element carrying it, not beside it.
    expect(marks[0].getAttribute("title")).toMatch(
      /recorded no configuration version for this row/,
    );
    expect(marks[0].querySelector("span")!.textContent).toBe("?");
  });

  it("puts the approximate marker beside a real time on a backfilled row", async () => {
    // The other half of the same bug. These rows have no `idp_tracking.initial_event_time`, so the
    // Started column read "—" and the `≈` annotated an em dash — on exactly the rows the marker exists
    // for. The mapper falls back to the row's top-level `idp_started_at`, which is the value the index
    // ordered the row by, so the marker now qualifies the time that explains its position in the list.
    const backfilled = toIdpDocument(backfilledRow("in/backfilled.pdf"));
    expect(backfilled.InitialEventTime).toBe("2026-03-04T00:00:00Z");
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), backfilled],
      nextToken: null,
    });
    await renderTab();

    const mark = screen.getByTitle(/^Approximate\./);
    const started = mark.parentElement!;
    expect(started.textContent).toContain(
      new Date("2026-03-04T00:00:00Z").toLocaleString(),
    );
    // Not an em dash with a caveat hanging off it, which is what shipped.
    expect(started.textContent).not.toContain("—");
  });

  it("says why no notice was mapped, without implying a fault", async () => {
    // A tracking-only row: the pipeline finished and recon mapped nothing out of it. The commonest
    // reason -- no notice date the extractor could read -- is what a document belonging to ANOTHER
    // deployment's configuration looks like from here, so this must not read as recon breaking.
    getIdpDocument.mockResolvedValue({
      ObjectKey: "in/notice.pdf",
      ObjectStatus: "COMPLETED",
      Sections: [],
      notice_failure_reason: "extracted no notice_date",
    });
    // What the extraction route can say on its own, which is an inference from an absent `idp_sections`
    // and wrong about a document that never became a notice at all.
    getIdpExtraction.mockResolvedValue({
      sections: [],
      unavailable:
        "this notice was extracted before recon stored per-field detail on the row",
    });
    await renderTab();
    fireEvent.click(screen.getByText("notice.pdf"));

    const shown = await waitFor(() =>
      screen.getByText(/extracted no notice_date/),
    );
    // Dim, not red: nothing failed here.
    expect(shown.getAttribute("style")).toContain("var(--rc-ink-dim)");
    // The row's own reason wins over the route's guess, rather than both being shown or the guess
    // winning because it arrived first.
    expect(
      screen.queryByText(/before recon stored per-field detail/),
    ).toBeNull();
    expect(screen.queryByText(/Failed to read what was extracted/)).toBeNull();
  });

  it("claims nothing about human review", async () => {
    // The IDP completion event carries no review fields in any form, so recon knows nothing about it.
    // "No review was triggered for this document" was the old copy, rendered from an absent field --
    // worse than silence, because it reads as a positive answer.
    await renderTab();
    fireEvent.click(screen.getByText("notice.pdf"));
    await waitFor(() =>
      expect(screen.getByTestId("source-preview")).toBeTruthy(),
    );
    expect(screen.queryByText(/review/i)).toBeNull();

    // And no review column left in the picker to sort an empty column by.
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    for (const label of ["Review", "Review asked", "Review done", "Reviewer"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("walks the window to its last page, and reads each page's fields", async () => {
    // What "Load more" used to be for. The list route pages a DynamoDB Query and reports no total, so a
    // document on page two was indistinguishable from one that was never processed -- and the filter box
    // only ever searched what had been fetched, which made the trap worse.
    listIdpDocuments.mockImplementation(
      async ({ nextToken }: { nextToken: string | null }) =>
        nextToken === null
          ? { documents: [doc("in/notice.pdf")], nextToken: "page-2" }
          : { documents: [doc("in/second-page.pdf")], nextToken: null },
    );
    getIdpExtractions.mockResolvedValue({
      extractions: { "in/notice.pdf": sections() },
      failed: {},
    });
    await renderTab();

    await waitFor(() =>
      expect(screen.getByText("second-page.pdf")).toBeTruthy(),
    );
    // Both pages, and then it stops: a null token is the end of the index.
    expect(listIdpDocuments).toHaveBeenCalledTimes(2);
    await settle();
    expect(listIdpDocuments).toHaveBeenCalledTimes(2);
    // The second page's fields were read too, and the key from the first was not asked for again.
    await waitFor(() =>
      expect(getIdpExtractions).toHaveBeenCalledWith(["in/second-page.pdf"]),
    );
    expect(getIdpExtractions).toHaveBeenCalledWith(["in/notice.pdf"]);
  });

  it("does not retry a page that failed, and keeps the pages already on screen", async () => {
    // ⚠️ The other runaway-loop guard. A failed page leaves `nextToken` exactly as it was, so the effect
    // that watches it would re-fire the instant `loading` dropped and retry the same token for as long as
    // the tab stayed open. The token ledger is what stops it.
    listIdpDocuments.mockImplementation(
      async ({ nextToken }: { nextToken: string | null }) => {
        if (nextToken === null)
          return { documents: [doc("in/notice.pdf")], nextToken: "page-2" };
        throw new Error("throttled");
      },
    );
    await renderTab();

    await waitFor(() =>
      expect(screen.getByText(/Failed to read documents — .*throttled/)),
    );
    await settle();
    // Twice: the good page and the one attempt at the bad one.
    expect(listIdpDocuments).toHaveBeenCalledTimes(2);
    // And the page that did arrive is still on screen -- a failure on page two must not empty page one.
    expect(screen.getByText("notice.pdf")).toBeTruthy();
  });

  it("says so when the pins could not be read at all", async () => {
    // The only signal of this anywhere in the app now that the caption under the filter row is gone. With
    // no pins to seed, the box is empty and the table quietly shows every loaded row INCLUDING other
    // deployments' -- which without this line is indistinguishable from a deployment that pins nothing.
    listWorkflowTypes.mockRejectedValue(new Error("config table missing"));
    const foreign = {
      ...doc("in/foreign.pdf"),
      ConfigVersion: "slim15-assess-no-granular",
    };
    listIdpDocuments.mockResolvedValue({
      documents: [doc("in/notice.pdf"), foreign],
      nextToken: null,
    });
    render(<IdpDocumentsPage />);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Could not read the configured workflow types — config table missing/,
        ),
      ).toBeTruthy(),
    );
    // It says what that means for the table under it, and the table agrees.
    expect(screen.getByText(/every loaded row is shown/)).toBeTruthy();
    expect(filterInput().value).toBe("");
    expect(screen.getByText("foreign.pdf")).toBeTruthy();
  });
});

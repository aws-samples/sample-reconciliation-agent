/**
 * The Documents tab's extracted-field columns, and the detail panel beside the source file.
 *
 * The tab shipped with the pipeline's tracking columns only — statuses, times, a page count — so the
 * one question an operator opens it to answer, "what did the extractor actually read out of this
 * notice", had no column and no panel. The values are not in the rows the table already has: they are
 * embedded on recon's own notice row, one lookup per document to reach.
 *
 * That cost is what shapes the tests below. Because reading is a deliberate act, the tab has THREE
 * states per cell, and an operator who cannot tell them apart is worse off than before:
 *
 *   - not read yet (a middle dot),
 *   - read, and this document has no section of that class (an em dash),
 *   - read, with a value and the confidence it was read at.
 *
 * And a document whose result could not be read at all has to be NAMED. Left silent it shows middle
 * dots in every column, which is indistinguishable from a button that did nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    HITLStatus: null,
    HITLTriggered: false,
    HITLCompleted: null,
    HITLReviewedBy: null,
    HITLReviewOwner: null,
    QueuedTime: null,
  } as unknown as IdpDocument;
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

/** Render the tab and wait for its first page of rows. */
async function renderTab() {
  render(<IdpDocumentsPage />);
  await waitFor(() => expect(screen.getByText("notice.pdf")).toBeTruthy());
}

/** Press the load button and wait for the field columns to be offered. */
async function loadFields() {
  fireEvent.click(
    screen.getByRole("button", { name: /Load extracted fields/ }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Extracted fields loaded/ }),
    ).toBeTruthy(),
  );
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

  it("offers no field column, and reads nothing, until asked", async () => {
    await renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.queryByText("paydown_notice · BorrowerName")).toBeNull();
    // Not a lazy load: a hundred-key read of the notices table is not something the tab should fire
    // because a page rendered.
    expect(getIdpExtractions).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Load extracted fields (1)" }),
    ).toBeTruthy();
  });

  it("offers one column per extracted field once they are read", async () => {
    await renderTab();
    await loadFields();
    expect(getIdpExtractions).toHaveBeenCalledWith(["in/notice.pdf"]);

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    // Namespaced by document class: the same field name means different things in a paydown notice and
    // in a wire confirmation, and one column holding both would put two figures under one header.
    expect(screen.getByText("paydown_notice · BorrowerName")).toBeTruthy();
    expect(screen.getByText("paydown_notice · PaydownAmount")).toBeTruthy();
    // Counted in the caption, because every one of them is hidden by default -- a column set that grew
    // by dozens with nothing on screen to say so reads as a button that did nothing.
    expect(
      screen.getByText(/2 extracted-field columns available under Columns/),
    ).toBeTruthy();
  });

  it("shows the value and its confidence once a field column is switched on", async () => {
    await renderTab();
    await loadFields();
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
    await loadFields();
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

  it("names a document whose extracted fields could not be read", async () => {
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
    await loadFields();

    // Named by file name, with the reason. Silently missing, this document would show middle dots in
    // every field column and look exactly like one nobody had loaded.
    expect(
      screen.getByText(/1 document whose extracted fields could not be read/),
    ).toBeTruthy();
    // File name and reason in one line: `expired.pdf` alone also matches the row up in the table, and
    // what is worth asserting is that the row and its reason are connected.
    expect(
      screen.getByText(
        /expired\.pdf — the pipeline has no record of this document/,
      ),
    ).toBeTruthy();
  });

  it("says so when the whole read failed rather than leaving the button spent", async () => {
    getIdpExtractions.mockRejectedValue(new Error("signing failed"));
    await renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: /Load extracted fields/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Could not read extracted fields — .*signing failed/),
      ).toBeTruthy(),
    );
    // Nothing was recorded as failed per key, so the button still offers the same work again.
    expect(
      screen.getByRole("button", { name: "Load extracted fields (1)" }),
    ).toBeTruthy();
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
});

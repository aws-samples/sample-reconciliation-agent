/**
 * The Exception Queue's column set.
 *
 * The queue shipped seven columns, all of them platform metadata, and its COLUMNS picker could
 * therefore offer nothing else — while `/api/recon/cases` had been returning the whole submitted item
 * all along, unprojected. Everything an analyst asked for was already in the browser with nowhere to
 * put it.
 *
 * The columns that fix that are DERIVED from the loaded rows, because the submitted item is free-form:
 * `sides[].attributes` is whatever the two systems being reconciled carry. So the tests below are about
 * the derivation, not about a fixed list — and in particular about the two ways a derived column set
 * goes wrong: it must not be derived from the search-FILTERED rows (typing would reshuffle the columns,
 * and `DataTable` re-reads its stored layout every time the set changes), and it must not offer a
 * column for a value no cell can render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReconCase } from "@/lib/reconApi";

const listCases = vi.fn();

vi.mock("@/lib/reconApi", () => ({
  listCases: (...a: unknown[]) => listCases(...a),
  bulkUpdateCases: vi.fn(),
}));
vi.mock("@/hooks/useReconSubject", () => ({
  useReconSubject: () => ({ subject: "", isAdmin: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// The create dialog pulls in the whole submission form; nothing here opens it.
vi.mock("@/components/recon/NewItemModal", () => ({
  NewItemModal: () => null,
}));

import QueuePage from "@/app/recon/queue/page";

/** A case as the route returns it: the whole item, unprojected. */
function reconCase(overrides: Partial<ReconCase> = {}): ReconCase {
  return {
    item_id: "IT-1",
    status: "PENDING",
    class_id: null,
    confidence: null,
    item: {
      domain: "loan_ops",
      tier: 1,
      source_refs: ["WIRE-20260302-EVG"],
      sides: [
        { name: "bank", attributes: { amount: "12500.00", currency: "USD" } },
        { name: "ledger", attributes: { amount: "12000.00", currency: "USD" } },
      ],
      attributes: {
        tier1_break_type: "amount_mismatch",
        settlement_date: "2026-09-01",
        // A structure. The hook stamps these on the same bag, and a cell is not where anybody reads
        // one, so no column should be offered for it.
        idp_sections: [{ classification: "paydown_notice" }],
      },
    },
    ...overrides,
  } as ReconCase;
}

/** Render the queue and open its column picker. */
async function openPicker() {
  render(<QueuePage />);
  await waitFor(() => expect(screen.getByText("IT-1")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Columns" }));
}

describe("Exception Queue columns", () => {
  beforeEach(() => {
    listCases.mockReset();
    listCases.mockResolvedValue([reconCase()]);
    // Each test starts from the shipped layout rather than the previous test's.
    window.localStorage.clear();
  });

  it("offers a column for every side attribute, namespaced by side", () => {
    return openPicker().then(() => {
      // `bank · amount` and `ledger · amount` are two columns, not one: the same attribute name on two
      // sides is the whole point of a reconciliation break.
      expect(screen.getByText("bank · amount")).toBeTruthy();
      expect(screen.getByText("bank · currency")).toBeTruthy();
      expect(screen.getByText("ledger · amount")).toBeTruthy();
      expect(screen.getByText("ledger · currency")).toBeTruthy();
    });
  });

  it("offers a column for a scalar item attribute the submitter sent", () => {
    return openPicker().then(() => {
      expect(screen.getByText("settlement_date")).toBeTruthy();
    });
  });

  it("offers no column for an attribute holding a structure", () => {
    return openPicker().then(() => {
      // `idp_sections` carries every extracted field of every section. A column of it would be a column
      // of `[object Object]`, which reads as a bug rather than as a considered omission.
      expect(screen.queryByText("idp_sections")).toBeNull();
    });
  });

  it("does not offer an attribute that already has a purpose-built column", () => {
    return openPicker().then(() => {
      // The Class column already renders `tier1_break_type`, labelled as a Tier-1 guess. Offering it
      // again unlabelled would put the same value on the row twice with two different meanings.
      expect(screen.queryByText("tier1_break_type")).toBeNull();
      // Twice over: the column header and its entry in the picker.
      expect(screen.getAllByText("Class")).toHaveLength(2);
      // And the value is on the row, from the Class column, marked as Tier-1's guess.
      expect(screen.getByText("amount_mismatch")).toBeTruthy();
    });
  });

  it("offers the item's fixed fields too, hidden until asked for", async () => {
    await openPicker();
    for (const label of ["Domain", "Tier", "Source refs", "IDP class"])
      expect(screen.getByText(label)).toBeTruthy();
    // Hidden by default: the row shows none of these until the box is ticked.
    expect(screen.queryByText("loan_ops")).toBeNull();
  });

  it("renders the value once a derived column is switched on", async () => {
    await openPicker();
    fireEvent.click(
      screen
        .getByText("bank · amount")
        .closest("label")!
        .querySelector("input")!,
    );
    await waitFor(() => expect(screen.getByText("12500.00")).toBeTruthy());
    // The other side's value stays hidden — one column was asked for, not both.
    expect(screen.queryByText("12000.00")).toBeNull();
  });

  it("keeps the column set stable while the row filter narrows the table", async () => {
    listCases.mockResolvedValue([
      reconCase(),
      reconCase({
        item_id: "IT-2",
        item: {
          sides: [{ name: "custodian", attributes: { quantity: "40" } }],
          attributes: {},
        },
      } as Partial<ReconCase>),
    ]);
    await openPicker();
    expect(screen.getByText("custodian · quantity")).toBeTruthy();

    // Filtering to IT-1 hides IT-2's row. Its column must remain OFFERED: deriving from the filtered
    // rows would drop and re-add columns on every keystroke, and `DataTable` re-reads the stored layout
    // each time its column set changes.
    fireEvent.change(screen.getByPlaceholderText("Search item / class…"), {
      target: { value: "IT-1" },
    });
    await waitFor(() => expect(screen.queryByText("IT-2")).toBeNull());
    expect(screen.getByText("custodian · quantity")).toBeTruthy();
  });

  it("offers a search box once the column set is large", async () => {
    await openPicker();
    // Derived columns push this table well past the point where the list is a menu you pick from
    // rather than one you read.
    const find = screen.getByLabelText("Find a column");
    fireEvent.change(find, { target: { value: "ledger" } });
    expect(screen.getByText("ledger · amount")).toBeTruthy();
    expect(screen.queryByText("bank · amount")).toBeNull();
    // Filtering the MENU must not touch the table: Item is a visible column and stays on screen.
    expect(screen.getByText("IT-1")).toBeTruthy();
  });
});

/**
 * The Exception Queue's column headers must line up with the values beneath them.
 *
 * `DataTable` renders the header and each body row as SEPARATE CSS grids sharing one
 * `grid-template-columns` string. Sharing the string is not enough: a track whose size depends on its
 * contents (`auto`, `min-content`, `max-content`, or a bare `Nfr`, which means `minmax(auto,Nfr)`)
 * resolves against the header's contents in one grid and the rows' contents in the other. The shipped
 * queue had both problems at once — six columns declared as bare `Nfr`, and a pinned trailing column
 * declared `auto` whose header is empty while its cell is an arrow — so the ~10px that column gained in
 * the row grid was redistributed across the flexible tracks and every header label sat progressively
 * further right than its column.
 *
 * jsdom does not lay grids out, so these tests assert the two properties that make the layout correct
 * by construction rather than measuring pixels: the header and the rows use the IDENTICAL template, and
 * no track in it is content-dependent. A pixel assertion would need a real layout engine and would
 * still only cover the one dataset it ran against.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReconCase } from "@/lib/reconApi";

const listCases = vi.fn();

vi.mock("@/lib/reconApi", () => ({
  listCases: (...a: unknown[]) => listCases(...a),
  bulkUpdateCases: vi.fn(),
}));
vi.mock("@/lib/reconToken", () => ({ getStoredAccessToken: () => "tok" }));
vi.mock("@/hooks/useReconSubject", () => ({
  useReconSubject: () => ({ subject: "", isAdmin: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/recon/NewItemModal", () => ({
  NewItemModal: () => null,
}));

import QueuePage from "@/app/recon/queue/page";

/** A case with a long value in it, so a content-sized track would visibly differ from its header. */
function reconCase(overrides: Partial<ReconCase> = {}): ReconCase {
  return {
    item_id: "MANUAL-SCENARIO-1-A-VERY-LONG-IDENTIFIER",
    status: "PROPOSED",
    class_id: "document-cross-reference",
    confidence: 0.83,
    item: {
      domain: "loan_ops",
      tier: 1,
      source_refs: ["WIRE-20260302-EVG"],
      sides: [
        { name: "bank", attributes: { amount: "12500.00", currency: "USD" } },
      ],
      attributes: { tier1_break_type: "amount_mismatch" },
    },
    ...overrides,
  } as ReconCase;
}

/**
 * Every distinct inline `grid-template-columns` on the page, in DOM order.
 *
 * Read off the rendered DOM rather than from the column definitions because the template is what the
 * browser actually resolves, and a normalisation applied in only one of the two places is precisely the
 * bug this file guards against.
 */
function templates(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[style*='grid-template-columns']"),
  ).map((el) => el.style.gridTemplateColumns);
}

async function renderQueue() {
  render(<QueuePage />);
  await waitFor(() =>
    expect(
      screen.getByText("MANUAL-SCENARIO-1-A-VERY-LONG-IDENTIFIER"),
    ).toBeTruthy(),
  );
}

describe("Exception Queue header alignment", () => {
  beforeEach(() => {
    listCases.mockReset();
    listCases.mockResolvedValue([reconCase()]);
    window.localStorage.clear();
  });

  it("gives the header grid and the row grid the same track template", async () => {
    await renderQueue();
    const found = templates();
    expect(found.length).toBeGreaterThan(1);
    // One distinct value: the header and every row agree.
    expect(new Set(found).size).toBe(1);
  });

  it("declares no content-dependent track", async () => {
    await renderQueue();
    const tracks = templates()[0].split(" ").filter(Boolean);
    expect(tracks.length).toBeGreaterThan(1);
    for (const track of tracks) {
      // `auto`/`min-content`/`max-content` size to their contents, and the header's contents are not
      // the rows'. `minmax(0,Nfr)` and a fixed length are the two safe forms.
      expect(track).not.toMatch(/^(auto|min-content|max-content)$/);
      // A BARE `Nfr` is `minmax(auto,Nfr)` — content-dependent through its minimum, which is the form
      // that shipped and is easy to reintroduce because it looks like a pure proportion.
      expect(track).not.toMatch(/^\d+(\.\d+)?fr$/);
    }
  });

  it("keeps both properties after a derived column is switched on", async () => {
    await renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(
      screen
        .getByText("bank · amount")
        .closest("label")!
        .querySelector("input")!,
    );
    await waitFor(() => expect(screen.getByText("12500.00")).toBeTruthy());
    const found = templates();
    expect(new Set(found).size).toBe(1);
    // The derived columns are generated in a `.map`, so they are the ones a regression would come back
    // through — one declaration covering however many columns the loaded rows happen to produce.
    for (const track of found[0].split(" ").filter(Boolean))
      expect(track).not.toMatch(/^(auto|\d+(\.\d+)?fr)$/);
  });
});

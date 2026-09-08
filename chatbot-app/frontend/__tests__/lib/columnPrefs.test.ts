/**
 * Column-layout persistence.
 *
 * Two kinds of assertion here. The reconciliation cases are about release drift: a stored layout outlives
 * the table it describes, so a removed column must not keep holding a slot and a new column must not be
 * invisible to everyone who ever used the table before. The subject cases are about a shared browser —
 * an empty subject must not become a key that every viewer writes to, which is the one failure in this
 * module that produces no error and no visible symptom.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadColumnPrefs,
  saveColumnPrefs,
  type ColumnPref,
} from "@/lib/columnPrefs";

const DEFAULTS: ColumnPref[] = [
  { id: "id", visible: true },
  { id: "status", visible: true },
  { id: "opened", visible: false },
];

/**
 * A real in-memory `localStorage`, replacing the shared one from `__tests__/setup.ts`.
 *
 * That one is `{ getItem: vi.fn(), setItem: vi.fn(), … }`, which reads back `undefined` for everything
 * ever written. Round-tripping is the entire subject here, so these tests need storage that stores.
 */
function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      get length() {
        return data.size;
      },
    },
  });
}

beforeEach(() => {
  installStorage();
});

describe("columnPrefs", () => {
  it("round-trips visibility and order", () => {
    const mine: ColumnPref[] = [
      { id: "status", visible: true },
      { id: "opened", visible: true },
      { id: "id", visible: false },
    ];
    saveColumnPrefs("cases", "sub-1", mine);

    expect(loadColumnPrefs("cases", "sub-1", DEFAULTS)).toEqual(mine);
  });

  it("drops a stored pref for a column that no longer exists", () => {
    // The column was shipped, someone arranged around it, then it was removed. Keeping the entry would
    // hold its slot and shift every column after it — a layout nobody chose.
    saveColumnPrefs("cases", "sub-1", [
      { id: "status", visible: true },
      { id: "retired", visible: true },
      { id: "id", visible: true },
    ]);

    expect(loadColumnPrefs("cases", "sub-1", DEFAULTS)).toEqual([
      { id: "status", visible: true },
      { id: "id", visible: true },
      // `opened` was never in the stored layout, so it is appended below with its shipped visibility.
      { id: "opened", visible: false },
    ]);
  });

  it("appends a column added since the layout was stored, at its shipped visibility", () => {
    saveColumnPrefs("cases", "sub-1", [
      { id: "id", visible: true },
      { id: "status", visible: false },
    ]);
    const withNew: ColumnPref[] = [
      ...DEFAULTS,
      { id: "confidence", visible: true },
    ];

    expect(loadColumnPrefs("cases", "sub-1", withNew)).toEqual([
      { id: "id", visible: true },
      { id: "status", visible: false },
      // Both newcomers arrive, each keeping the visibility it ships with: `confidence` is visible, and
      // `opened` stays hidden. A new column that ships hidden is hidden on purpose — usually because the
      // table is already too wide — so "new" must not mean "forced on".
      { id: "opened", visible: false },
      { id: "confidence", visible: true },
    ]);
  });

  it("falls back to defaults on a corrupt stored value rather than throwing", () => {
    // Reached by a half-written value or a hand-edited one. A thrown error here would blank the table.
    localStorage.setItem("recon:cols:sub-1:cases", "{not json");
    expect(loadColumnPrefs("cases", "sub-1", DEFAULTS)).toEqual(DEFAULTS);

    localStorage.setItem("recon:cols:sub-1:cases", '{"id":"status"}');
    expect(loadColumnPrefs("cases", "sub-1", DEFAULTS)).toEqual(DEFAULTS);

    // Right shape, every entry unusable — indistinguishable from having stored nothing.
    localStorage.setItem(
      "recon:cols:sub-1:cases",
      '[{"id":1,"visible":"yes"}]',
    );
    expect(loadColumnPrefs("cases", "sub-1", DEFAULTS)).toEqual(DEFAULTS);
  });

  it("keeps two subjects' layouts apart", () => {
    saveColumnPrefs("cases", "sub-1", [{ id: "id", visible: false }]);
    saveColumnPrefs("cases", "sub-2", [{ id: "status", visible: false }]);

    expect(loadColumnPrefs("cases", "sub-1", DEFAULTS)[0]).toEqual({
      id: "id",
      visible: false,
    });
    expect(loadColumnPrefs("cases", "sub-2", DEFAULTS)[0]).toEqual({
      id: "status",
      visible: false,
    });
  });

  it("refuses an empty subject instead of storing under a shared key", () => {
    // The state before /api/recon/me answers. A placeholder key would work perfectly on one laptop and
    // silently merge two people's layouts on a shared one, so nothing is written and nothing is read.
    saveColumnPrefs("cases", "", [{ id: "id", visible: false }]);

    expect(localStorage.length).toBe(0);
    expect(loadColumnPrefs("cases", "", DEFAULTS)).toEqual(DEFAULTS);
  });

  it("keeps two tables' layouts apart for one subject", () => {
    saveColumnPrefs("cases", "sub-1", [{ id: "id", visible: false }]);

    expect(loadColumnPrefs("documents", "sub-1", DEFAULTS)).toEqual(DEFAULTS);
  });
});

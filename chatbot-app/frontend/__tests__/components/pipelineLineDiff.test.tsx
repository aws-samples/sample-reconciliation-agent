/**
 * The line diff under a skill proposal.
 *
 * A reviewer approves what the diff shows, so it has to be a real minimal diff: unchanged lines kept,
 * a changed line shown as a removal then an addition, nothing invented. The bound that keeps the
 * drawer responsive on absurd inputs is pinned as well, since a silently frozen tab is the failure
 * mode of a quadratic algorithm.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "@/components/pipeline/textDiff";
import { LineDiff } from "@/components/pipeline/LineDiff";

describe("diffLines", () => {
  it("returns every line as `same` for identical texts", () => {
    const d = diffLines("a\nb\nc\n", "a\nb\nc\n");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
    ]);
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
  });

  it("shows a changed line as a removal followed by an addition, keeping the rest", () => {
    const before = "## Covenants\nLeave Covenant Status # blank.\n## Agents\nUse the name as written.\n";
    const after =
      "## Covenants\nLoans always carry Covenant Status #; cov-lite is 3.\n## Agents\nUse the OMS canonical counterparty name.\n";
    expect(diffLines(before, after)).toEqual([
      { kind: "same", text: "## Covenants" },
      { kind: "del", text: "Leave Covenant Status # blank." },
      { kind: "add", text: "Loans always carry Covenant Status #; cov-lite is 3." },
      { kind: "same", text: "## Agents" },
      { kind: "del", text: "Use the name as written." },
      { kind: "add", text: "Use the OMS canonical counterparty name." },
    ]);
  });

  it("handles pure insertions, pure deletions and empty inputs", () => {
    expect(diffLines("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
    expect(diffLines("x\ny", "")).toEqual([
      { kind: "del", text: "x" },
      { kind: "del", text: "y" },
    ]);
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("a\nb", "a\nNEW\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "NEW" },
      { kind: "same", text: "b" },
    ]);
  });

  it("treats CRLF and LF alike and ignores a single trailing newline", () => {
    expect(diffLines("a\r\nb\r\n", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("finds the longest common subsequence, not just a greedy match", () => {
    // Greedy line matching would pair the first "x" with the wrong "x" and report three changes.
    expect(diffStats(diffLines("x\ny\nx", "y\nx"))).toEqual({ added: 0, removed: 1 });
  });

  it("falls back to a coarse diff above the cell bound rather than freezing", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const d = diffLines(big, `${big}\nextra`);
    // 2501 × 2500 cells is over the bound, so the whole old text is removed and the new added.
    expect(diffStats(d)).toEqual({ added: 2501, removed: 2500 });
  });
});

describe("<LineDiff>", () => {
  it("renders a summary and one row per diff line", () => {
    render(<LineDiff before={"a\nb"} after={"a\nc"} />);
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(document.querySelectorAll('[data-kind="same"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-kind="del"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-kind="add"]')).toHaveLength(1);
  });

  it("says so when the proposed content is identical", () => {
    render(<LineDiff before="same" after="same" />);
    expect(screen.getByText(/identical to the current skill/)).toBeTruthy();
  });
});

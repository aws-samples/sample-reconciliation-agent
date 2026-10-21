// A line-level diff for the skill-proposal drawer: which lines of a SKILL.md the assistant wants to
// add, remove or keep. Longest-common-subsequence over whole lines, no dependencies — a skill file
// is a few hundred lines at most, so the quadratic table is a few hundred kilobytes and the result
// is the minimal edit script a reviewer expects from any diff tool.

/** One line of the diff. `same` lines appear in both texts; `del` only in the old; `add` only in the new. */
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/**
 * Above this many cell comparisons the LCS table is not worth building: the drawer would freeze on a
 * pair of long texts to produce a diff nobody can read at that size anyway. Past the bound the whole
 * old text is shown removed and the whole new text added, which is still a correct (if coarse) diff.
 */
const MAX_CELLS = 4_000_000;

/** Split into lines, treating a trailing newline as a terminator rather than as an extra empty line. */
function lines(text: string): string[] {
  const out = text.split(/\r?\n/);
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Diff two texts line by line.
 *
 * @param before the current content.
 * @param after the proposed content.
 * @returns the edit script in display order: unchanged lines interleaved with removals (old text) and
 *   additions (new text), removals first at each change point.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]. Filled from the bottom-right so the walk
  // below can read it top-down and emit lines in document order.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      // Dropping the old line keeps at least as much common text as dropping the new one, so the old
      // line is the one that went. Ties resolve to a removal, which puts `del` before `add` at every
      // change point — the order every diff viewer uses.
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Counts for a diff's summary line. */
export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

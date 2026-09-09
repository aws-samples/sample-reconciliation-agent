import { describe, expect, it } from "vitest";

import {
  DEFAULT_LESSON_FILTER,
  decisionOf,
  filterLessons,
  hasComment,
  lessonFilterCounts,
  lessonFilterOptions,
  type LessonFilter,
} from "@/lib/lessonFilter";
import type { Lesson } from "@/lib/reconApi";

/** A ledger row with every displayed field set; individual tests override what they care about. */
function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    lesson_id: "case-1#USER_CORRECTION",
    created_at: "2026-09-08T12:00:00Z",
    domain: "lending",
    class_id: "unmapped_facility",
    item_id: "case-1",
    trigger: "USER_CORRECTION",
    disposition: "MANUAL_REVIEW",
    user_comment: "Facility mapping must be fixed before this can be closed.",
    ...overrides,
  };
}

/** The wall of comment-less bulk-triage rows the default filter exists to remove. */
const BULK_NO_COMMENT = lesson({
  lesson_id: "case-2#BULK_STATUS",
  item_id: "case-2",
  trigger: "BULK_STATUS",
  disposition: "CLOSED_NO_ACTION",
  user_comment: undefined,
});

describe("hasComment", () => {
  it("accepts a real comment", () => {
    expect(hasComment(lesson())).toBe(true);
  });

  it("rejects a missing, empty, or whitespace-only comment", () => {
    expect(hasComment(lesson({ user_comment: undefined }))).toBe(false);
    expect(hasComment(lesson({ user_comment: "" }))).toBe(false);
    // Renders as blank, so it must not survive a filter whose whole point is to exclude blanks.
    expect(hasComment(lesson({ user_comment: "   \n\t " }))).toBe(false);
  });
});

describe("decisionOf", () => {
  it("prefers the disposition the analyst chose", () => {
    expect(decisionOf(lesson({ disposition: "CLOSED_MATCHED" }))).toBe(
      "CLOSED_MATCHED",
    );
  });

  it("falls back to the trigger when no disposition was recorded", () => {
    expect(decisionOf(lesson({ disposition: undefined }))).toBe(
      "USER_CORRECTION",
    );
  });
});

describe("filterLessons with the default filter", () => {
  it("hides comment-less rows and keeps the ones that explain a decision", () => {
    const rows = [lesson(), BULK_NO_COMMENT];
    const shown = filterLessons({
      lessons: rows,
      filter: DEFAULT_LESSON_FILTER,
    });
    expect(shown.map((l) => l.item_id)).toEqual(["case-1"]);
  });

  it("restores every row once the comment-only narrowing is turned off", () => {
    const rows = [lesson(), BULK_NO_COMMENT];
    const shown = filterLessons({
      lessons: rows,
      filter: { ...DEFAULT_LESSON_FILTER, commentOnly: false },
    });
    expect(shown).toHaveLength(2);
  });

  it("preserves the caller's ordering", () => {
    const a = lesson({ item_id: "a", lesson_id: "a" });
    const b = lesson({ item_id: "b", lesson_id: "b" });
    const shown = filterLessons({
      lessons: [b, a],
      filter: DEFAULT_LESSON_FILTER,
    });
    expect(shown.map((l) => l.item_id)).toEqual(["b", "a"]);
  });
});

describe("filterLessons query", () => {
  /** Query-only filter: the comment-only default would otherwise mask what the query did. */
  const queryFilter = (query: string): LessonFilter => ({
    commentOnly: false,
    query,
    domain: "",
    decision: "",
  });

  it("matches every displayed field, case-insensitively", () => {
    const rows = [lesson()];
    for (const q of [
      "CASE-1",
      "lending",
      "UNMAPPED_facility",
      "manual_review",
      "user_correction",
      "mapping must be fixed",
    ]) {
      expect(
        filterLessons({ lessons: rows, filter: queryFilter(q) }),
      ).toHaveLength(1);
    }
  });

  it("drops rows the query does not appear in", () => {
    expect(
      filterLessons({
        lessons: [lesson()],
        filter: queryFilter("counterparty"),
      }),
    ).toHaveLength(0);
  });

  it("treats a blank query as no narrowing at all", () => {
    expect(
      filterLessons({ lessons: [lesson()], filter: queryFilter("   ") }),
    ).toHaveLength(1);
  });
});

describe("filterLessons selects", () => {
  const rows = [
    lesson({ item_id: "a", lesson_id: "a", domain: "lending" }),
    lesson({
      item_id: "b",
      lesson_id: "b",
      domain: "treasury",
      disposition: "CLOSED_MATCHED",
    }),
    lesson({
      item_id: "c",
      lesson_id: "c",
      domain: "treasury",
      disposition: undefined,
      trigger: "USER_APPROVED",
    }),
  ];

  it("narrows to one domain", () => {
    const shown = filterLessons({
      lessons: rows,
      filter: {
        commentOnly: false,
        query: "",
        domain: "treasury",
        decision: "",
      },
    });
    expect(shown.map((l) => l.item_id)).toEqual(["b", "c"]);
  });

  it("matches a decision by disposition", () => {
    const shown = filterLessons({
      lessons: rows,
      filter: {
        commentOnly: false,
        query: "",
        domain: "",
        decision: "CLOSED_MATCHED",
      },
    });
    expect(shown.map((l) => l.item_id)).toEqual(["b"]);
  });

  it("matches a decision by trigger when the row has no disposition", () => {
    const shown = filterLessons({
      lessons: rows,
      filter: {
        commentOnly: false,
        query: "",
        domain: "",
        decision: "USER_APPROVED",
      },
    });
    expect(shown.map((l) => l.item_id)).toEqual(["c"]);
  });
});

describe("lessonFilterCounts", () => {
  it("reports the comment-less total independently of the other predicates", () => {
    const rows = [
      lesson({ item_id: "a", lesson_id: "a", domain: "lending" }),
      lesson({ item_id: "b", lesson_id: "b", domain: "treasury" }),
      BULK_NO_COMMENT,
    ];
    const counts = lessonFilterCounts({
      lessons: rows,
      // A domain narrowing that removes a commented row too — hiddenNoComment must not absorb it.
      filter: { ...DEFAULT_LESSON_FILTER, domain: "lending" },
    });
    expect(counts).toEqual({ total: 3, shown: 1, hiddenNoComment: 1 });
  });
});

describe("lessonFilterOptions", () => {
  it("returns sorted, de-duplicated, blank-free options", () => {
    const rows = [
      lesson({ lesson_id: "1", domain: "treasury", disposition: "B" }),
      lesson({ lesson_id: "2", domain: "lending", disposition: "A" }),
      lesson({ lesson_id: "3", domain: "lending", disposition: "A" }),
      lesson({
        lesson_id: "4",
        domain: "",
        disposition: undefined,
        trigger: "C",
      }),
    ];
    expect(lessonFilterOptions(rows)).toEqual({
      domains: ["lending", "treasury"],
      decisions: ["A", "B", "C"],
    });
  });
});

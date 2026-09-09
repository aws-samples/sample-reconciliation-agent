/**
 * Filtering for the Lessons Learned table.
 *
 * The ledger records a lesson row for every analyst decision, including bulk queue triage where the
 * analyst set a status and typed nothing. Those rows carry no reasoning, so the Comment column — the
 * one thing the tab exists to show — is empty for most of the table, and the rows that do explain a
 * decision are buried among them. Hence the default: comment-less rows are hidden.
 *
 * A default that hides data has to say so. `lessonFilterCounts` exists for exactly that: the page
 * prints how many rows the default removed, so "17 lessons" never silently reads as "3".
 *
 * Pure and DOM-free on purpose — the predicates are the part worth testing, and a test that has to
 * mount a React tree to check whether a whitespace-only comment counts as a comment is a test nobody
 * writes.
 */

import type { Lesson } from "@/lib/reconApi";

/** The four independent narrowings the tab offers. All are ANDed together. */
export interface LessonFilter {
  /** Hide rows without a comment. TRUE by default — see the module docstring. */
  commentOnly: boolean;
  /** Free text, matched case-insensitively across case, domain, class, decision and comment. */
  query: string;
  /** Exact domain match. Empty string means every domain. */
  domain: string;
  /** Exact decision match against `disposition`, falling back to `trigger`. Empty means all. */
  decision: string;
}

/** The filter the tab opens with. Comment-less rows are hidden until someone asks for them. */
export const DEFAULT_LESSON_FILTER: LessonFilter = {
  commentOnly: true,
  query: "",
  domain: "",
  decision: "",
};

/** What the page shows next to the table so the hiding default is visible rather than silent. */
export interface LessonFilterCounts {
  /** Rows loaded from the ledger. */
  total: number;
  /** Rows the current filter leaves visible. */
  shown: number;
  /** Rows that have no comment, whether or not the other predicates would also have removed them. */
  hiddenNoComment: number;
}

/** The option lists for the two select controls, derived from the loaded rows. */
export interface LessonFilterOptions {
  domains: string[];
  decisions: string[];
}

/**
 * Whether a lesson carries an analyst comment.
 *
 * The single definition of "has a comment" in the console. All-whitespace does not count: a row whose
 * comment is `"   "` renders as blank, so treating it as present would put an apparently empty row
 * back into a view whose entire purpose is to exclude those.
 *
 * @param lesson the ledger row to test.
 * @returns true when `user_comment` is present and non-blank.
 */
export function hasComment(lesson: Lesson): boolean {
  return (lesson.user_comment ?? "").trim().length > 0;
}

/**
 * The decision label a row is filtered and displayed by.
 *
 * `disposition` is the status the analyst chose and is what an operator thinks of as the decision;
 * `trigger` (USER_APPROVED / USER_CORRECTION / BULK_STATUS) is the mechanism, and is only used when
 * no disposition was recorded.
 *
 * @param lesson the ledger row to label.
 * @returns the disposition, or the trigger when there is none.
 */
export function decisionOf(lesson: Lesson): string {
  return lesson.disposition ?? lesson.trigger;
}

/**
 * Whether a row matches a free-text query.
 *
 * @param lesson the ledger row to test.
 * @param query the raw query text; blank matches everything.
 * @returns true when the query appears in any of the row's displayed fields.
 */
function matchesQuery(lesson: Lesson, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    lesson.item_id,
    lesson.domain,
    lesson.class_id,
    decisionOf(lesson),
    lesson.trigger,
    lesson.user_comment ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Apply a filter to the loaded lessons, preserving their order.
 *
 * @param lessons the rows as loaded from the ledger (already sorted by the caller).
 * @param filter the active filter.
 * @returns the subset the filter admits, in the input order.
 */
export function filterLessons({
  lessons,
  filter,
}: {
  lessons: Lesson[];
  filter: LessonFilter;
}): Lesson[] {
  return lessons.filter((l) => {
    if (filter.commentOnly && !hasComment(l)) return false;
    if (filter.domain && l.domain !== filter.domain) return false;
    if (filter.decision && decisionOf(l) !== filter.decision) return false;
    return matchesQuery(l, filter.query);
  });
}

/**
 * Count what the filter kept and what the comment-only default removed.
 *
 * `hiddenNoComment` is deliberately independent of the other predicates: it answers "how much of the
 * ledger is comment-less", which is the number that explains the default, rather than "how many rows
 * did this particular combination of filters drop".
 *
 * @param lessons the rows as loaded from the ledger.
 * @param filter the active filter.
 * @returns the totals the page displays alongside the table.
 */
export function lessonFilterCounts({
  lessons,
  filter,
}: {
  lessons: Lesson[];
  filter: LessonFilter;
}): LessonFilterCounts {
  return {
    total: lessons.length,
    shown: filterLessons({ lessons, filter }).length,
    hiddenNoComment: lessons.filter((l) => !hasComment(l)).length,
  };
}

/**
 * Derive the select options from the loaded rows.
 *
 * Derived rather than hardcoded so a new exception class or disposition is filterable the moment it
 * appears in the ledger, without a frontend change.
 *
 * @param lessons the rows as loaded from the ledger.
 * @returns sorted, de-duplicated, blank-free option lists.
 */
export function lessonFilterOptions(lessons: Lesson[]): LessonFilterOptions {
  const uniqueSorted = (values: string[]): string[] =>
    [...new Set(values.filter((v) => v && v.trim().length > 0))].sort((a, b) =>
      a.localeCompare(b),
    );
  return {
    domains: uniqueSorted(lessons.map((l) => l.domain)),
    decisions: uniqueSorted(lessons.map((l) => decisionOf(l))),
  };
}

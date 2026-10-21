/**
 * Deals table (design §4) and the staging CSV that shadows each deal in S3.
 *
 * The parser Lambda creates deals (STAGED) and the mock OMS Lambda records upload outcomes; the
 * BFF owns edits, approval and rejection. Every mutation appends a history row naming the verified
 * actor, because the review screen's audit trail is the point of the human step.
 *
 * Every status transition here is a conditional write on the status the caller READ. The routes
 * check `isOpen()` on a GetItem snapshot and then write the whole item back, and two writers can
 * pass that check for the same row — a second reviewer, a stale tab, or the OMS Lambda finishing
 * inside the approve window. Without the condition the later write silently replaces the earlier
 * one (a REJECTED row flips back to UPLOADED, an edit erases the Lambda's verdict); with it,
 * DynamoDB refuses and the route answers 409 so the caller reloads and sees what really happened.
 */

import type {
  DealHistoryEntry,
  DealRecord,
  DealStatus,
  FieldOverride,
  FieldValues,
  OverrideMemory,
  UploadError,
  UploadResult,
} from "@/lib/pipeline/types";
import { changedKeys, fieldDef, OMS_FIELDS, toCsvRows } from "@/lib/pipeline/omsSchema";
import { dealRows, isMultiOrder, orderName, ordersOf, withOrderValues } from "@/lib/pipeline/orders";
import { overridesOf } from "@/lib/pipeline/overrides";

/** Every OMS field key, in schema order — the order overrides and history lines follow. */
const OMS_KEYS = OMS_FIELDS.map((f) => f.key);
import { newOverrideId } from "./ids";
import {
  getItem,
  isConditionalCheckFailed,
  putItem,
  putText,
  scanAll,
  type GetItemOptions,
  type PutCondition,
} from "./aws";
import { env } from "./env";

/** Deals, newest first, optionally capped for the assistant's `list_deals`. */
export async function listDeals(limit?: number): Promise<DealRecord[]> {
  const items = await scanAll<DealRecord>(env.dealsTable());
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return limit && limit > 0 ? items.slice(0, limit) : items;
}

export async function getDeal(
  dealId: string,
  options: GetItemOptions = {},
): Promise<DealRecord | null> {
  return getItem<DealRecord>(env.dealsTable(), { deal_id: dealId }, options);
}

/**
 * The write guard for a transition: the stored row must still hold the status the caller read and,
 * when given, the `updated_at` it read.
 *
 * Status alone stops a decision from replacing another decision. It does not stop a whole-item put
 * from erasing an override that landed in between without changing the status — a second reviewer
 * correcting another field, or the memory outcome being recorded — and overrides are an audit trail
 * the memory has already learned from, so losing one silently is not acceptable. `updated_at` moves
 * on every write, so it catches those too.
 */
function expectRow(status: DealStatus, updatedAt?: string): PutCondition {
  if (updatedAt === undefined) {
    return {
      expression: "#status = :expected",
      names: { "#status": "status" },
      values: { ":expected": status },
    };
  }
  return {
    expression: "#status = :expected AND #updated_at = :updated_at",
    names: { "#status": "status", "#updated_at": "updated_at" },
    values: { ":expected": status, ":updated_at": updatedAt },
  };
}

/**
 * Write a deal back whole.
 *
 * @param expectedStatus when given, the write is refused with `ConditionalCheckFailedException`
 *   unless the stored row is still in that status — the status the caller read before deciding.
 * @param expectedUpdatedAt when given too, the stored row must also still carry this `updated_at`.
 */
export async function putDeal(
  deal: DealRecord,
  expectedStatus?: DealStatus,
  expectedUpdatedAt?: string,
): Promise<void> {
  await putItem(
    env.dealsTable(),
    deal,
    expectedStatus ? expectRow(expectedStatus, expectedUpdatedAt) : undefined,
  );
}

/**
 * Append a history row and bump `updated_at`. Pure — the caller decides when to persist, so one
 * edit that changes fields, status and history is one write.
 */
export function appendHistory(
  deal: DealRecord,
  action: DealHistoryEntry["action"],
  actor: string,
  detail?: string,
  now: Date = new Date(),
): DealRecord {
  const at = now.toISOString();
  return {
    ...deal,
    history: [...(deal.history ?? []), { at, actor, action, detail }],
    updated_at: at,
  };
}

/** Regenerate the staging CSV from the deal's current fields. */
export async function writeDealCsv(deal: DealRecord): Promise<void> {
  await putText(deal.csv_key, toCsvRows(dealRows(deal)), "text/csv");
}

/** A value as the history line quotes it. */
function quoted(value: string): string {
  return value ? `"${value}"` : "(blank)";
}

/**
 * Apply overrides from a review screen: the reviewer's new values, each with the reason they gave.
 *
 * Three things happen together, and they are ordered so a failure leaves nothing misleading
 * behind: the CSV is rewritten first (it is what the OMS will validate), then the record with the
 * new fields, one `FieldOverride` per changed field, an EDITED history row quoting each change and
 * its reason, and — when the previous upload was rejected — the status back to STAGED so the
 * Approve button reappears. Writing the record first would show the edit as saved while the OMS
 * still saw the old file.
 *
 * An override made while the deal is UPLOAD_FAILED is a "break" fix and carries the codes of the
 * rejection that named its field, so the lesson the memory extracts can say which OMS rule the
 * correction satisfies. Every new override starts with memory `pending`; the route sends the
 * lessons once this write has succeeded and records the outcome with `recordOverrideMemory`.
 *
 * The record write is conditional on the status and `updated_at` the caller read. When it is
 * refused, the CSV has already been rewritten from an edit that was never recorded, so it is
 * regenerated from the row that won before the conflict propagates — otherwise the file the OMS
 * validates would disagree with the fields the review screen shows.
 *
 * On a deal of several orders one call changes one set of orders, and each changed field becomes
 * ONE override naming them (`order_indexes`) — one lesson for the memory, however many orders it
 * corrected.
 *
 * @param orderIndexes the orders this change applies to (`[0]` on a single-order deal).
 * @param fieldsFor the complete new field set for each of those orders, every changed value
 *   already validated.
 * @param reasons a non-empty reason for every key whose value changes (the route enforces this).
 * @returns the written deal and the overrides this call added, in field order.
 * @throws ConditionalCheckFailedException when the deal changed since it was read.
 */
export async function applyOverrides(
  deal: DealRecord,
  orderIndexes: number[],
  fieldsFor: Map<number, FieldValues>,
  reasons: Record<string, string>,
  actor: string,
  now: Date = new Date(),
): Promise<{ deal: DealRecord; added: FieldOverride[] }> {
  const at = now.toISOString();
  const stage = deal.status === "UPLOAD_FAILED" ? "break" : "review";
  const orders = ordersOf(deal);
  const multi = isMultiOrder(deal);
  // The first order in scope speaks for all of them: the route only lets several orders share an
  // override when they shared the value it replaces.
  const lead = orders[orderIndexes[0]];
  const next = fieldsFor.get(orderIndexes[0])!;
  const changed = OMS_KEYS.filter((key) =>
    orderIndexes.some((i) => changedKeys(orders[i].fields, fieldsFor.get(i)!).includes(key)),
  );
  const added: FieldOverride[] = changed.map((key) => {
    // A break fix carries the codes of the rejection that named this field — in one of these
    // orders' rows, when the file had several.
    const codes =
      stage === "break"
        ? (deal.upload?.errors ?? [])
            .filter((e) => e.field === key && (e.row === undefined || orderIndexes.includes(e.row)))
            .map((e) => e.code)
        : [];
    return {
      override_id: newOverrideId(now),
      field: key,
      parsed_value: lead.original_fields[key] ?? "",
      previous_value: lead.fields[key] ?? "",
      value: next[key] ?? "",
      reason: reasons[key],
      actor,
      at,
      stage,
      ...(codes.length ? { upload_error_codes: [...new Set(codes)] } : {}),
      ...(multi ? { order_indexes: [...orderIndexes] } : {}),
      memory: { status: "pending" },
    };
  });
  const edited: DealRecord = {
    ...withOrderValues(deal, fieldsFor),
    status: deal.status === "UPLOAD_FAILED" ? "STAGED" : deal.status,
    overrides: [...overridesOf(deal), ...added],
  };
  // Which orders a line is about, when there are several: "[EUR 5yr] " or "[all 5 orders] ".
  const scope = !multi
    ? ""
    : orderIndexes.length === orders.length
      ? `[all ${orders.length} orders] `
      : `[${orderIndexes.map((i) => orderName(orders, i)).join(", ")}] `;
  const detail = added
    .map(
      (o) =>
        `${scope}${fieldDef(o.field)?.label ?? o.field}: ${quoted(o.previous_value)} → ${quoted(o.value)} — ${o.reason}`,
    )
    .join("\n");
  const withHistory = appendHistory(edited, "EDITED", actor, detail, now);
  await writeDealCsv(withHistory);
  try {
    await putDeal(withHistory, deal.status, deal.updated_at);
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      const winner = await getDeal(deal.deal_id, { consistent: true });
      // Best effort: the conflict is the error worth reporting, not a failed CSV restore.
      if (winner) await writeDealCsv(winner).catch(() => undefined);
    }
    throw err;
  }
  return { deal: withHistory, added };
}

/**
 * Write a change to a deal's overrides back without undoing anything that landed since it was read.
 *
 * The put is conditional on the `updated_at` the change builds on; on a conflict the change is
 * re-applied once to a fresh, strongly consistent read. What happens on a second conflict is the
 * caller's call: bookkeeping may give up (`mustLand: false`, returning the deal as it would have
 * been), a reviewer's action may not (`mustLand: true` rethrows, and the route answers 409).
 */
async function rewriteOverrides(
  deal: DealRecord,
  apply: (d: DealRecord) => DealRecord,
  mustLand: boolean,
): Promise<DealRecord> {
  const write = async (base: DealRecord): Promise<DealRecord> => {
    const next = apply(base);
    await putItem(env.dealsTable(), next, {
      expression: "#updated_at = :updated_at",
      names: { "#updated_at": "updated_at" },
      values: { ":updated_at": base.updated_at },
    });
    return next;
  };
  try {
    return await write(deal);
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
  const fresh = await getDeal(deal.deal_id, { consistent: true });
  if (!fresh) {
    if (mustLand) throw new Error(`deal ${deal.deal_id} no longer exists`);
    return apply(deal);
  }
  try {
    return await write(fresh);
  } catch (err) {
    if (!isConditionalCheckFailed(err) || mustLand) throw err;
    return apply(fresh);
  }
}

/**
 * Record whether each new override's lesson reached the knowledge memory.
 *
 * Bookkeeping after the fact: if both attempts lose their race the overrides stay `pending` — the
 * lessons were sent either way; only the record of it is missing.
 *
 * @param outcomes memory outcome per override id.
 * @returns the deal as written, or as it would have been if both attempts lost their race.
 */
export function recordOverrideMemory(
  deal: DealRecord,
  outcomes: Record<string, OverrideMemory>,
  now: Date = new Date(),
): Promise<DealRecord> {
  return rewriteOverrides(
    deal,
    (d) => ({
      ...d,
      overrides: overridesOf(d).map((o) =>
        outcomes[o.override_id] ? { ...o, memory: outcomes[o.override_id] } : o,
      ),
      updated_at: now.toISOString(),
    }),
    false,
  );
}

/**
 * Mark overrides' lessons retracted after their records were deleted, with a LESSON_RETRACTED
 * history row naming each field and how many records went.
 *
 * The overrides, and the values they set, stay: a retract takes back what the parser learned, not
 * the correction to this deal. Must land — it is a reviewer's action — so a second lost race throws.
 *
 * @param deleted records deleted per override id; overrides not named are left alone.
 * @throws ConditionalCheckFailedException when the deal kept changing under both attempts.
 */
export function markLessonsRetracted(
  deal: DealRecord,
  deleted: Record<string, number>,
  actor: string,
  now: Date = new Date(),
): Promise<DealRecord> {
  const at = now.toISOString();
  return rewriteOverrides(
    deal,
    (d) => {
      const retracted = overridesOf(d).filter((o) => o.override_id in deleted);
      const detail = retracted
        .map((o) => {
          const n = deleted[o.override_id];
          return `${fieldDef(o.field)?.label ?? o.field}: lesson retracted (${n} record${n === 1 ? "" : "s"} deleted)`;
        })
        .join("\n");
      const next: DealRecord = {
        ...d,
        overrides: overridesOf(d).map((o) =>
          o.override_id in deleted
            ? { ...o, memory: { ...o.memory, status: "retracted", retracted_by: actor, retracted_at: at } }
            : o,
        ),
      };
      return retracted.length ? appendHistory(next, "LESSON_RETRACTED", actor, detail, now) : next;
    },
    true,
  );
}

/** What the OMS upload Lambda returns; every field but `accepted` is defensively optional. */
export interface UploadLambdaResult {
  accepted?: boolean;
  errors?: UploadError[];
  staging_key?: string | null;
  validator_version?: string;
  attempted_at?: string;
}

/** Coerce a Lambda response into the wire `UploadResult`, filling anything the Lambda omitted. */
export function toUploadResult(raw: UploadLambdaResult, now: Date = new Date()): UploadResult {
  return {
    attempted_at: raw.attempted_at ?? now.toISOString(),
    accepted: raw.accepted === true,
    staging_key: raw.staging_key ?? null,
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    validator_version: raw.validator_version ?? "unknown",
  };
}

/** Statuses from which approve and edit are meaningful; the others are terminal. */
export function isOpen(deal: DealRecord): boolean {
  return deal.status !== "UPLOADED" && deal.status !== "REJECTED";
}

/**
 * Move a deal to APPROVED ahead of the OMS upload.
 *
 * Conditional on the status the caller read (STAGED, UPLOAD_FAILED, or APPROVED for the retry after
 * a failed invoke — the condition is the read status, not a fixed one, precisely so that retry path
 * keeps working) and on its `updated_at`, so an override saved in between is not written over.
 *
 * @throws ConditionalCheckFailedException when the deal changed since it was read.
 */
export async function markApproved(
  deal: DealRecord,
  actor: string,
  now: Date = new Date(),
): Promise<DealRecord> {
  const approved = appendHistory(
    { ...deal, status: "APPROVED" },
    "APPROVED",
    actor,
    undefined,
    now,
  );
  await putDeal(approved, deal.status, deal.updated_at);
  return approved;
}

/**
 * Record an upload outcome on the deal.
 *
 * The mock OMS Lambda normally persists this itself; the BFF calls this only when it reloads the
 * deal after the invoke and finds the Lambda left it APPROVED, so the verdict the Lambda returned
 * still reaches the record instead of being dropped on the floor.
 *
 * Conditional on the row still being APPROVED: if the Lambda's own write lands between the reload
 * and this put, this one is refused rather than replacing the Lambda's history row with one
 * attributed to the reviewer.
 *
 * @throws ConditionalCheckFailedException when the deal is no longer APPROVED.
 */
export async function recordUpload(
  deal: DealRecord,
  upload: UploadResult,
  actor: string,
  now: Date = new Date(),
): Promise<DealRecord> {
  const detail = upload.accepted
    ? `written to ${upload.staging_key ?? "oms-staging"}`
    : upload.errors.map((e) => e.code).join(", ");
  const updated = appendHistory(
    {
      ...deal,
      status: upload.accepted ? "UPLOADED" : "UPLOAD_FAILED",
      upload,
    },
    upload.accepted ? "UPLOAD_ACCEPTED" : "UPLOAD_REJECTED",
    actor,
    detail,
    now,
  );
  await putDeal(updated, "APPROVED");
  return updated;
}

/**
 * Reject a deal with the reviewer's reason.
 *
 * @throws ConditionalCheckFailedException when the deal changed since it was read.
 */
export async function markRejected(
  deal: DealRecord,
  reason: string,
  actor: string,
  now: Date = new Date(),
): Promise<DealRecord> {
  const rejected = appendHistory(
    { ...deal, status: "REJECTED" },
    "REJECTED",
    actor,
    reason,
    now,
  );
  await putDeal(rejected, deal.status, deal.updated_at);
  return rejected;
}

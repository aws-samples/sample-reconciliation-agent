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
  FieldValues,
  UploadError,
  UploadResult,
} from "@/lib/pipeline/types";
import { changedKeys, toCsv } from "@/lib/pipeline/omsSchema";
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

/** The write guard for a transition: the stored row must still hold the status the caller read. */
function expectStatus(status: DealStatus): PutCondition {
  return {
    expression: "#status = :expected",
    names: { "#status": "status" },
    values: { ":expected": status },
  };
}

/**
 * Write a deal back whole.
 *
 * @param expectedStatus when given, the write is refused with `ConditionalCheckFailedException`
 *   unless the stored row is still in that status — the status the caller read before deciding.
 */
export async function putDeal(deal: DealRecord, expectedStatus?: DealStatus): Promise<void> {
  await putItem(
    env.dealsTable(),
    deal,
    expectedStatus ? expectStatus(expectedStatus) : undefined,
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
  await putText(deal.csv_key, toCsv(deal.fields), "text/csv");
}

/**
 * Apply an edit from the review screen.
 *
 * Three things happen together, and they are ordered so a failure leaves nothing misleading
 * behind: the CSV is rewritten first (it is what the OMS will validate), then the record with the
 * new fields, an EDITED history row naming the changed columns, and — when the previous upload
 * was rejected — the status back to STAGED so the Approve button reappears. Writing the record
 * first would show the edit as saved while the OMS still saw the old file.
 *
 * The record write is conditional on the status the caller read. When it is refused, the CSV has
 * already been rewritten from an edit that was never recorded, so it is regenerated from the row
 * that won before the conflict propagates — otherwise the file the OMS validates would disagree
 * with the fields the review screen shows.
 *
 * @param fields the complete, already-validated field set (see `validateFields`).
 * @throws ConditionalCheckFailedException when the deal's status changed since it was read.
 */
export async function applyEdit(
  deal: DealRecord,
  fields: FieldValues,
  actor: string,
  now: Date = new Date(),
): Promise<DealRecord> {
  const changed = changedKeys(deal.fields, fields);
  const edited: DealRecord = {
    ...deal,
    fields,
    // Denormalised for the list screens; must follow the field or the table shows a stale name.
    opportunity_name: fields.opportunity_name || deal.opportunity_name,
    status: deal.status === "UPLOAD_FAILED" ? "STAGED" : deal.status,
  };
  const withHistory = appendHistory(
    edited,
    "EDITED",
    actor,
    changed.length ? `changed ${changed.join(", ")}` : "no field changes",
    now,
  );
  await writeDealCsv(withHistory);
  try {
    await putDeal(withHistory, deal.status);
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      const winner = await getDeal(deal.deal_id, { consistent: true });
      // Best effort: the conflict is the error worth reporting, not a failed CSV restore.
      if (winner) await writeDealCsv(winner).catch(() => undefined);
    }
    throw err;
  }
  return withHistory;
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
 * keeps working).
 *
 * @throws ConditionalCheckFailedException when the deal's status changed since it was read.
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
  await putDeal(approved, deal.status);
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
 * @throws ConditionalCheckFailedException when the deal's status changed since it was read.
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
  await putDeal(rejected, deal.status);
  return rejected;
}

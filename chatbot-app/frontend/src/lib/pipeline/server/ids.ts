/**
 * Identifier generators for emails, deals and skill proposals (design §4).
 *
 * Every id starts with a time component so a plain string sort is also a chronological sort,
 * which is what the list screens want and what makes a DynamoDB scan usable without a sort index.
 * The randomness that follows is what makes them unique: the demo re-simulates the same sample
 * email several times, sometimes within the same second, and two emails must never share an id.
 */

import { randomBytes } from "node:crypto";

// Crockford base32, as used by ULID: no I, L, O or U, so ids read unambiguously when spoken.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode `value` as `length` base32 digits, most significant first. */
function encodeBase32(value: number, length: number): string {
  let out = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * A 26-character ULID: 10 base32 digits of millisecond timestamp + 16 of randomness.
 *
 * Hand-rolled rather than a dependency because it is twelve lines and the project already avoids
 * pulling in packages for one call site.
 */
export function ulid(now: Date = new Date()): string {
  const time = encodeBase32(now.getTime(), 10);
  const bytes = randomBytes(16);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}

/** Lower-case alphanumeric slug of the first word-ish token, for readable email ids. */
function slugOf(subject: string): string {
  const cleaned = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .join("-");
  return cleaned || "email";
}

/** `YYYYMMDDTHHMMSS` in UTC — compact, sortable, and readable in a table cell. */
function compactTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").slice(0, 15);
}

/**
 * Email id: `em_<YYYYMMDDTHHMMSS>_<subject slug>_<4 random>`, e.g. `em_20260810T134200_northwind-automotive_7f3k`.
 *
 * The slug exists so an operator scanning the Inbox table or an S3 listing can tell the emails
 * apart without opening them; the suffix is what keeps two simulations of the same sample in the
 * same second distinct.
 */
export function newEmailId(subject: string, now: Date = new Date()): string {
  const suffix = ulid(now).slice(-4).toLowerCase();
  return `em_${compactTimestamp(now)}_${slugOf(subject)}_${suffix}`;
}

/** Deal id: `dl_<ulid>`. */
export function newDealId(now: Date = new Date()): string {
  return `dl_${ulid(now)}`;
}

/** Skill proposal id: `sp_<ulid>`. */
export function newProposalId(now: Date = new Date()): string {
  return `sp_${ulid(now)}`;
}

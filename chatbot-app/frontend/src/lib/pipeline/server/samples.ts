/**
 * The simulated inbox: the fictional sample emails, read from `data/deal-emails` when that directory
 * is present and from the assets bucket when it is not.
 *
 * Two sources because the same code runs in two places. Under `next dev` the checkout is right
 * there and an edited or added sample should show up without a restart, so the directory is read on
 * every call. In the console's container `data/` is not shipped — the image holds only the built
 * app — so the composed Terraform seeds the corpus to S3 under `PIPELINE_SAMPLES_PREFIX` and the
 * BFF reads it from there. Both sources yield the same `SampleEmail` shape and the same ids (the
 * file name without `.json`), so the simulate dialog cannot tell which one answered.
 *
 * Nothing is cached in either mode: the corpus is seven small files and the dialog is opened a
 * handful of times per demo.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ListObjectsV2Command } from "@aws-sdk/client-s3";

import type { SampleEmail, SourceKind } from "@/lib/pipeline/types";
import { getText, s3 } from "./aws";
import { env } from "./env";

/** One corpus file as stored: the full email plus its corpus id. */
export interface SampleEmailFile {
  id: string;
  source_kind: SourceKind;
  from: string;
  to: string;
  cc?: string;
  sent: string;
  subject: string;
  body: string;
}

/** Where the corpus is being read from. Exported so a health check or a test can say which. */
export type SamplesSource =
  | { kind: "directory"; dir: string }
  | { kind: "s3"; prefix: string };

const SOURCE_KINDS: readonly SourceKind[] = ["news-alert", "bank-notice", "manual"];

// Corpus ids double as file names and S3 key segments, so the same pattern that keeps them readable
// also keeps a request from reaching outside the samples directory or prefix.
const SAMPLE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Absolute samples directory: `SAMPLE_EMAILS_DIR` resolved against the server's cwd. */
export function samplesDir(): string {
  return resolve(process.cwd(), env.sampleEmailsDir());
}

/**
 * Decide the source for this call.
 *
 * The directory wins whenever it exists, whether `SAMPLE_EMAILS_DIR` named it or the default did:
 * a developer with the checkout wants the files they can edit. Only its absence sends reads to S3.
 * Decided per call rather than once, because tests flip the variable between cases and because a
 * `next dev` process should not remember a directory that was created after it started.
 */
export async function resolveSamplesSource(): Promise<SamplesSource> {
  const dir = samplesDir();
  try {
    if ((await stat(dir)).isDirectory()) return { kind: "directory", dir };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { kind: "s3", prefix: env.samplesPrefix() };
}

/** Coerce a corpus file's `source_kind` to the wire enum; anything unexpected reads as "manual". */
function sourceKindOf(value: unknown): SourceKind {
  return SOURCE_KINDS.includes(value as SourceKind)
    ? (value as SourceKind)
    : "manual";
}

/**
 * Normalise one corpus document.
 *
 * The id is the name the document was read under (file or object name without `.json`), not any
 * `id` the JSON carries: the dialog POSTs back what it listed and the reader looks up `<id>.json`,
 * so a document whose own `id` disagreed with its name would list under one id and 404 under it.
 */
function parseSampleFile(text: string, id: string): SampleEmailFile {
  const raw = JSON.parse(text) as Partial<SampleEmailFile>;
  return {
    id,
    source_kind: sourceKindOf(raw.source_kind),
    from: String(raw.from ?? ""),
    to: String(raw.to ?? ""),
    cc: raw.cc ? String(raw.cc) : undefined,
    sent: String(raw.sent ?? ""),
    subject: String(raw.subject ?? ""),
    body: String(raw.body ?? ""),
  };
}

const JSON_SUFFIX = /\.json$/;

/**
 * Corpus ids under the S3 prefix, in key order.
 *
 * Only direct children ending in `.json` count: a nested key or a stray README under the prefix is
 * not a sample. Paginated because ListObjectsV2 caps a page at 1000 keys — irrelevant for seven
 * files, but a truncated listing that silently dropped the tail is exactly the class of bug the
 * platform refuses to have.
 */
async function listS3SampleIds(prefix: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: env.assetsBucket(),
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      const rest = obj.Key?.startsWith(prefix) ? obj.Key.slice(prefix.length) : "";
      if (!rest || rest.includes("/") || !JSON_SUFFIX.test(rest)) continue;
      ids.push(rest.replace(JSON_SUFFIX, ""));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return ids.sort();
}

/** Read one corpus document from whichever source is live; null when it is not there. */
async function readSample(
  source: SamplesSource,
  id: string,
): Promise<SampleEmailFile | null> {
  if (source.kind === "directory") {
    try {
      const text = await readFile(join(source.dir, `${id}.json`), "utf8");
      return parseSampleFile(text, id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  const text = await getText(`${source.prefix}${id}.json`);
  return text === null ? null : parseSampleFile(text, id);
}

/**
 * The corpus as the simulate dialog lists it, in file-name order.
 *
 * File-name order is the corpus author's narrative order (the files are numbered), which is what
 * a demo wants to walk through top to bottom. The S3 listing is sorted the same way so the two
 * sources agree.
 */
export async function listSamples(): Promise<SampleEmail[]> {
  const source = await resolveSamplesSource();
  const ids =
    source.kind === "directory"
      ? (await readdir(source.dir))
          .filter((n) => JSON_SUFFIX.test(n))
          .map((n) => n.replace(JSON_SUFFIX, ""))
          .sort()
      : await listS3SampleIds(source.prefix);
  const out: SampleEmail[] = [];
  for (const id of ids) {
    const file = await readSample(source, id);
    // Listed a moment ago and gone now: a concurrent delete, not an error the dialog should show.
    if (!file) continue;
    out.push({
      id: file.id,
      subject: file.subject,
      source_kind: file.source_kind,
      sent: file.sent,
      from: file.from,
    });
  }
  return out;
}

/**
 * One corpus email in full.
 *
 * @returns the email, or null when the id is not a corpus id (including ids that fail the
 *   character check — refusing those is what keeps this from being a file-read primitive, on disk
 *   or in the bucket).
 */
export async function getSample(id: string): Promise<SampleEmailFile | null> {
  if (!SAMPLE_ID.test(id)) return null;
  return readSample(await resolveSamplesSource(), id);
}

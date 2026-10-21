/**
 * An in-memory S3 bucket behind the `__cmd`-tagged client mock (`awsMocks.s3Module`).
 *
 * Replaces the `installBucket` in `api/pipelineSamples.test.ts` and the S3 half of `installFakes` in
 * `api/pipelineSkills.test.ts`. Objects are strings keyed by object key.
 *
 *   - `GetObject` throws an error named `NoSuchKey` for an absent key (the readers distinguish that
 *     from any other failure) and otherwise answers a `Body` with `transformToString()`.
 *   - `PutObject` stores the body; `Delete` removes the key.
 *   - `List` filters on `Prefix` and paginates with `ContinuationToken` / `IsTruncated` /
 *     `NextContinuationToken`. Keys come back in insertion order, NOT sorted, so a reader that must
 *     sort is still exercised. Page size is `pageSize`, or the size that splits the listing into
 *     `pages` pages — a corpus of five keys and `pages: 3` walks three pages.
 * Anything else throws, so an unexpected call fails the test that made it.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */

/** The tagged input a mocked S3 command hands `send`. */
export interface FakeS3Command {
  __cmd: string;
  Bucket?: string;
  Key?: string;
  Body?: unknown;
  ContentType?: string;
  Prefix?: string;
  ContinuationToken?: string;
}

export interface FakeS3Options {
  /** Keys per `List` page. */
  pageSize?: number;
  /** Alternatively, how many pages the whole listing should take. */
  pages?: number;
}

export interface FakeBucket {
  /** Object key -> body. Seed and inspect directly. */
  objects: Record<string, string>;
  /** Handle one command the way the service would; attach with `s3Send.mockImplementation(fake.send)`. */
  send: (cmd: FakeS3Command) => Promise<unknown>;
  /** Empty the bucket in place (so a kept `objects` reference stays valid), then store `seed`. */
  reset(seed?: Record<string, string>): void;
}

/** An error shaped the way the SDK shapes a missing object. */
export function noSuchKey(): Error {
  return Object.assign(new Error("nsk"), { name: "NoSuchKey" });
}

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body);
}

export function createFakeS3(objects: Record<string, string> = {}, options: FakeS3Options = {}): FakeBucket {
  return {
    objects,
    reset(seed = {}) {
      for (const key of Object.keys(objects)) delete objects[key];
      Object.assign(objects, seed);
    },
    async send(cmd) {
      switch (cmd.__cmd) {
        case "GetObject": {
          const key = cmd.Key ?? "";
          if (!(key in objects)) throw noSuchKey();
          return { Body: { transformToString: async () => objects[key] } };
        }
        case "PutObject":
          objects[cmd.Key ?? ""] = bodyText(cmd.Body);
          return {};
        case "Delete":
          delete objects[cmd.Key ?? ""];
          return {};
        case "List": {
          const keys = Object.keys(objects).filter((k) => k.startsWith(cmd.Prefix ?? ""));
          const size =
            options.pageSize ??
            (options.pages ? Math.ceil(keys.length / options.pages) : Math.max(keys.length, 1));
          const start = Number(cmd.ContinuationToken ?? "0");
          const next = start + size;
          return {
            Contents: keys.slice(start, next).map((Key) => ({ Key })),
            IsTruncated: next < keys.length,
            NextContinuationToken: next < keys.length ? String(next) : undefined,
          };
        }
        default:
          throw new Error(`unexpected S3 command ${cmd.__cmd}`);
      }
    },
  };
}

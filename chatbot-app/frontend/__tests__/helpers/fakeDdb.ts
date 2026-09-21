/**
 * An in-memory DynamoDB table behind the `__cmd`-tagged client mock (`awsMocks.dynamoDbModule`).
 *
 * Replaces the `installTable` / `FakePut` / `conditionHolds` trio that `api/pipelineDeals.test.ts` and
 * `api/pipelineEmails.test.ts` each carried, and the smaller GetItem/PutItem/Scan fakes in
 * `api/pipelineSkills.test.ts` and `api/pipelineChat.test.ts`.
 *
 * What it honours, because the stores under test depend on it:
 *   - `GetItem` by the unmarshalled key attribute, marshalled back with undefined values dropped, and
 *     an `afterGet` hook that runs after the n-th read (1-based) has been served — the seam through
 *     which a race test changes the row between a route's read and its write.
 *   - `PutItem` evaluating `ConditionExpression` against the stored row and throwing DynamoDB's
 *     `ConditionalCheckFailedException` when it does not hold. The evaluator covers the shapes the
 *     stores use: `attribute_exists(#a)`, `attribute_not_exists(#a)`, `#a = :v`, `#a <> :v`, joined by
 *     `AND` / `OR` without parentheses. A store that uses one condition shape can pin it with
 *     `conditionExpression`, which asserts every condition seen is exactly that string.
 *   - `DeleteItem` by key; `Scan` and `Query` return every row marshalled (Query does not evaluate
 *     its key condition — seed the table with what the query should find).
 * Anything else throws, so an unexpected call fails the test that made it rather than answering `{}`.
 *
 * `rows` is cleared in place by `reset()`, so a test may keep a reference to it (`const table =
 * fake.rows`) across cases. `send` is bound to the fake, so `ddbSend.mockImplementation(fake.send)`
 * survives `vi.clearAllMocks()` (which keeps implementations). The corollary: `reset()` does not
 * re-install `send`, so a case that overrides the mock (`ddbSend.mockRejectedValueOnce(...)`) must
 * use a `...Once` variant or re-install `fake.send` itself, or the override leaks into later cases.
 * Rows are marshalled with `removeUndefinedValues`, so an `undefined` attribute is dropped rather
 * than rejected as the real client would.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { expect } from "vitest";

/** The tagged input a mocked DynamoDB command hands `send`. */
export interface FakeDdbCommand {
  __cmd: string;
  TableName?: string;
  Key?: Record<string, unknown>;
  Item?: Record<string, unknown>;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ConsistentRead?: boolean;
}

export interface FakeTableOptions {
  /** The partition key attribute, e.g. `deal_id`. */
  keyAttr: string;
  /** When set, every `ConditionExpression` seen must be exactly this string. */
  conditionExpression?: string;
}

export interface FakeTable<T extends object> {
  /** Key value -> stored row. Seed and inspect directly. */
  rows: Record<string, T>;
  /** Handle one command the way the service would; attach with `ddbSend.mockImplementation(fake.send)`. */
  send: (cmd: FakeDdbCommand) => Promise<unknown>;
  /** Runs after the n-th GetItem (1-based) has been served — a concurrent writer between read and write. */
  afterGet: ((n: number) => void) | null;
  /** Empty the table, clear `afterGet` and restart the GetItem counter. */
  reset(): void;
}

/** An error shaped the way the SDK shapes a failed conditional write. */
export function conditionalCheckFailed(): Error {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

const MARSHALL_OPTS = { removeUndefinedValues: true } as const;

function evaluateCondition(cmd: FakeDdbCommand, current: Record<string, unknown> | undefined): boolean {
  const expression = cmd.ConditionExpression!;
  const names = cmd.ExpressionAttributeNames ?? {};
  const values = cmd.ExpressionAttributeValues
    ? (unmarshall(cmd.ExpressionAttributeValues as never) as Record<string, unknown>)
    : {};
  const attr = (placeholder: string) => {
    const name = placeholder.startsWith("#") ? names[placeholder] : placeholder;
    if (name === undefined) throw new Error(`unknown attribute name ${placeholder} in ${expression}`);
    return name;
  };
  const value = (placeholder: string) => {
    if (!(placeholder in values)) throw new Error(`unknown value ${placeholder} in ${expression}`);
    return values[placeholder];
  };
  const term = (text: string): boolean => {
    let m = /^attribute_not_exists\((\S+)\)$/.exec(text);
    if (m) return current?.[attr(m[1])] === undefined;
    m = /^attribute_exists\((\S+)\)$/.exec(text);
    if (m) return current?.[attr(m[1])] !== undefined;
    m = /^(\S+)\s*(=|<>)\s*(\S+)$/.exec(text);
    if (m) {
      const equal = current?.[attr(m[1])] === value(m[3]);
      return m[2] === "=" ? equal : !equal;
    }
    throw new Error(`unsupported ConditionExpression term "${text}" in "${expression}"`);
  };
  // `OR` binds looser than `AND`, as in DynamoDB.
  return expression
    .split(/\s+OR\s+/i)
    .some((clause) => clause.split(/\s+AND\s+/i).every((t) => term(t.trim())));
}

export function createFakeTable<T extends object = Record<string, unknown>>(options: FakeTableOptions): FakeTable<T> {
  const { keyAttr, conditionExpression } = options;
  const rows: Record<string, T> = {};
  let gets = 0;

  const keyOf = (record: object): string => String((record as Record<string, unknown>)[keyAttr]);

  const fake: FakeTable<T> = {
    rows,
    afterGet: null,
    reset() {
      for (const key of Object.keys(rows)) delete rows[key];
      fake.afterGet = null;
      gets = 0;
    },
    async send(cmd) {
      switch (cmd.__cmd) {
        case "GetItem": {
          const key = keyOf(unmarshall(cmd.Key as never));
          const snapshot = rows[key] ? marshall(rows[key] as Record<string, unknown>, MARSHALL_OPTS) : undefined;
          fake.afterGet?.(++gets);
          return { Item: snapshot };
        }
        case "PutItem": {
          const item = unmarshall(cmd.Item as never) as T;
          const key = keyOf(item);
          if (cmd.ConditionExpression) {
            if (conditionExpression !== undefined) expect(cmd.ConditionExpression).toBe(conditionExpression);
            if (!evaluateCondition(cmd, rows[key] as Record<string, unknown> | undefined)) throw conditionalCheckFailed();
          }
          rows[key] = item;
          return {};
        }
        case "DeleteItem": {
          delete rows[keyOf(unmarshall(cmd.Key as never))];
          return {};
        }
        case "Scan":
        case "Query":
          return { Items: Object.values(rows).map((row) => marshall(row as Record<string, unknown>, MARSHALL_OPTS)) };
        default:
          throw new Error(`unexpected ${cmd.__cmd}`);
      }
    },
  };
  return fake;
}

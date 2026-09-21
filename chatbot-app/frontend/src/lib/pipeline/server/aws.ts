/**
 * Lazily constructed, process-wide AWS SDK clients for the pipeline BFF.
 *
 * One client per service, built on first use: constructing an SDK client resolves the credential
 * chain and region, which is cheap but not free, and a route that is hit once per second should not
 * repeat it. Built lazily rather than at import so that a route which only touches S3 never pays
 * for — or fails on — a Bedrock client, and so tests can set `AWS_REGION` before the first call.
 *
 * DynamoDB is used through the low-level client plus `marshall`/`unmarshall` because the project
 * does not depend on `@aws-sdk/lib-dynamodb`; the two helpers here keep that detail out of the
 * stores.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";

import { env } from "./env";

/** Build-once cache keyed by client constructor. */
function lazy<T>(build: () => T): () => T {
  let instance: T | undefined;
  return () => {
    if (instance === undefined) instance = build();
    return instance;
  };
}

export const ddb = lazy(() => new DynamoDBClient({ region: env.region() }));
export const s3 = lazy(() => new S3Client({ region: env.region() }));
export const lambda = lazy(() => new LambdaClient({ region: env.region() }));
export const bedrock = lazy(
  () => new BedrockRuntimeClient({ region: env.region() }),
);
export const agentcore = lazy(
  () => new BedrockAgentCoreClient({ region: env.region() }),
);
export const agentcoreControl = lazy(
  () => new BedrockAgentCoreControlClient({ region: env.region() }),
);

export interface GetItemOptions {
  /**
   * Strongly consistent read. DynamoDB's default read may lag a write by up to a second, which is
   * exactly the window a caller re-reading a row another writer (a Lambda) has just updated falls
   * into. Costs double the read capacity, so it is opt-in for the reads that need it.
   */
  consistent?: boolean;
}

/**
 * Read one item by primary key.
 *
 * @returns the unmarshalled item, or null when the key does not exist.
 */
export async function getItem<T>(
  table: string,
  key: Record<string, string>,
  options: GetItemOptions = {},
): Promise<T | null> {
  const got = await ddb().send(
    new GetItemCommand({
      TableName: table,
      Key: marshall(key),
      ConsistentRead: options.consistent === true ? true : undefined,
    }),
  );
  return got.Item ? (unmarshall(got.Item) as T) : null;
}

/**
 * A guard on a whole-item write: the put only succeeds while the stored item still satisfies it.
 *
 * The stores read a row, decide, and write it back whole. Without a condition the write clobbers
 * whatever landed in between — a second reviewer's decision, the OMS Lambda's verdict — so every
 * state transition names the state it read and lets DynamoDB refuse the write when that is no
 * longer true. The refusal surfaces as `ConditionalCheckFailedException`; see
 * `isConditionalCheckFailed`.
 */
export interface PutCondition {
  /** DynamoDB condition expression, e.g. `#status = :expected`. */
  expression: string;
  /** Placeholders for attribute names (`#status` → `status`). */
  names?: Record<string, string>;
  /** Placeholders for values, marshalled here. */
  values?: Record<string, unknown>;
}

/**
 * Write a whole item, replacing any existing one with the same key.
 *
 * @param condition when given, the write is refused (throws `ConditionalCheckFailedException`)
 *   unless the stored item satisfies it at write time.
 */
export async function putItem(
  table: string,
  item: object,
  condition?: PutCondition,
): Promise<void> {
  await ddb().send(
    new PutItemCommand({
      TableName: table,
      // Optional fields the wire types mark with `?` arrive as undefined; DynamoDB rejects them.
      Item: marshall(item, { removeUndefinedValues: true }),
      ...(condition
        ? {
            ConditionExpression: condition.expression,
            ExpressionAttributeNames: condition.names,
            ExpressionAttributeValues: condition.values
              ? marshall(condition.values, { removeUndefinedValues: true })
              : undefined,
          }
        : {}),
    }),
  );
}

/**
 * Whether an error is DynamoDB refusing a conditional write.
 *
 * Matched by name rather than `instanceof` the SDK class so callers stay testable with a mocked
 * client module, and because the SDK surfaces the same failure under the same `name` from both
 * `PutItem` and `UpdateItem`.
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "ConditionalCheckFailedException";
}

/**
 * Read every item in a table.
 *
 * A scan is the right call for this demo's tables (tens of rows, one desk) and it keeps the
 * Terraform module free of list indexes whose only purpose would be ordering — the callers sort in
 * memory. Paginated because DynamoDB caps a single page at 1 MB even when the table is small.
 */
export async function scanAll<T>(table: string): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb().send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: startKey }),
    );
    for (const raw of page.Items ?? []) items.push(unmarshall(raw) as T);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/**
 * Read a text object from the assets bucket.
 *
 * @returns the body as a string, or null when the key does not exist. Other failures (access
 *   denied, network) propagate — a missing object is a normal state for a not-yet-seeded prompt or
 *   a deleted skill, while a permission error is something the operator must see.
 */
export async function getText(key: string): Promise<string | null> {
  try {
    const got = await s3().send(
      new GetObjectCommand({ Bucket: env.assetsBucket(), Key: key }),
    );
    return (await got.Body?.transformToString()) ?? "";
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

/** Write a text object to the assets bucket with an explicit content type. */
export async function putText(
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.assetsBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

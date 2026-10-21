/**
 * Mock-module builders for the AWS SDK clients the BFF routes use.
 *
 * Replaces the per-file `vi.mock("@aws-sdk/client-x", () => ({ ... }))` factories that spelt out, for
 * every command, `XCommand: vi.fn().mockImplementation((i) => ({ __cmd: "X", ...i }))` and a client
 * class whose `send` is the test's own `vi.fn()`. A route under test therefore hands `send` a plain
 * object tagged with `__cmd`, which the test (or one of the in-memory fakes beside this file) can
 * dispatch on and assert against.
 *
 * Hoisting. `vi.mock` calls are hoisted above the imports, but a factory only RUNS when the mocked
 * module is first imported, so a factory may call these builders provided either
 *   - the subject is imported with `await import()` after the `vi.mock` call, or
 *   - this module is imported textually BEFORE a static import of the subject.
 * When the subject is imported statically, create `send` with `vi.hoisted(() => vi.fn())`; with a
 * dynamic import a plain `const send = vi.fn()` above the import is enough.
 *
 * Tags default to the names the pipeline and console tests assert on. A test whose assertions use
 * other tags (recon's `Get`/`Put`/`Update`) passes an override map as the second argument.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */
import { vi } from "vitest";

/** `vi.fn().mockImplementation((i) => ({ __cmd: tag, ...i }))` — the command constructor stand-in. */
export function taggedCommand(tag: string) {
  return vi.fn().mockImplementation((input: object) => ({ __cmd: tag, ...input }));
}

/** `vi.fn().mockImplementation(() => ({ send }))` — the client class stand-in. */
export function clientClass(send: unknown) {
  return vi.fn().mockImplementation(() => ({ send }));
}

type TagMap = Readonly<Record<string, string>>;

function commands<T extends TagMap>(tags: T, overrides: Partial<Record<keyof T, string>> = {}) {
  const out: Record<string, ReturnType<typeof taggedCommand>> = {};
  for (const [name, tag] of Object.entries(tags)) {
    out[name] = taggedCommand(overrides[name as keyof T] ?? tag);
  }
  return out;
}

export const DYNAMODB_TAGS = {
  GetItemCommand: "GetItem",
  PutItemCommand: "PutItem",
  UpdateItemCommand: "UpdateItem",
  DeleteItemCommand: "DeleteItem",
  QueryCommand: "Query",
  ScanCommand: "Scan",
  BatchWriteItemCommand: "BatchWrite",
} as const;

export const S3_TAGS = {
  GetObjectCommand: "GetObject",
  PutObjectCommand: "PutObject",
  ListObjectsV2Command: "List",
  DeleteObjectCommand: "Delete",
  HeadObjectCommand: "Head",
  CopyObjectCommand: "Copy",
} as const;

export const SSM_TAGS = {
  GetParameterCommand: "Get",
  GetParametersByPathCommand: "GetByPath",
  PutParameterCommand: "Put",
  DeleteParameterCommand: "Delete",
} as const;

export const LAMBDA_TAGS = {
  InvokeCommand: "Invoke",
} as const;

export const AGENTCORE_TAGS = {
  RetrieveMemoryRecordsCommand: "Retrieve",
  ListMemoryRecordsCommand: "ListRecords",
  BatchDeleteMemoryRecordsCommand: "BatchDelete",
  CreateEventCommand: "CreateEvent",
  ListEventsCommand: "ListEvents",
} as const;

export const AGENTCORE_CONTROL_TAGS = {
  GetMemoryCommand: "GetMemory",
} as const;

export const BEDROCK_RUNTIME_TAGS = {
  ConverseStreamCommand: "ConverseStream",
  ConverseCommand: "Converse",
  InvokeModelCommand: "InvokeModel",
} as const;

/** `@aws-sdk/client-dynamodb` */
export function dynamoDbModule(send: unknown, tags?: Partial<Record<keyof typeof DYNAMODB_TAGS, string>>) {
  return { DynamoDBClient: clientClass(send), ...commands(DYNAMODB_TAGS, tags) };
}

/** `@aws-sdk/client-s3` */
export function s3Module(send: unknown, tags?: Partial<Record<keyof typeof S3_TAGS, string>>) {
  return { S3Client: clientClass(send), ...commands(S3_TAGS, tags) };
}

/** `@aws-sdk/client-ssm` */
export function ssmModule(send: unknown, tags?: Partial<Record<keyof typeof SSM_TAGS, string>>) {
  return { SSMClient: clientClass(send), ...commands(SSM_TAGS, tags) };
}

/** `@aws-sdk/client-lambda` */
export function lambdaModule(send: unknown, tags?: Partial<Record<keyof typeof LAMBDA_TAGS, string>>) {
  return { LambdaClient: clientClass(send), ...commands(LAMBDA_TAGS, tags) };
}

/** `@aws-sdk/client-bedrock-agentcore` */
export function agentCoreModule(send: unknown, tags?: Partial<Record<keyof typeof AGENTCORE_TAGS, string>>) {
  return { BedrockAgentCoreClient: clientClass(send), ...commands(AGENTCORE_TAGS, tags) };
}

/** `@aws-sdk/client-bedrock-agentcore-control` */
export function agentCoreControlModule(
  send: unknown,
  tags?: Partial<Record<keyof typeof AGENTCORE_CONTROL_TAGS, string>>,
) {
  return { BedrockAgentCoreControlClient: clientClass(send), ...commands(AGENTCORE_CONTROL_TAGS, tags) };
}

/** `@aws-sdk/client-bedrock-runtime` */
export function bedrockRuntimeModule(
  send: unknown,
  tags?: Partial<Record<keyof typeof BEDROCK_RUNTIME_TAGS, string>>,
) {
  return { BedrockRuntimeClient: clientClass(send), ...commands(BEDROCK_RUNTIME_TAGS, tags) };
}

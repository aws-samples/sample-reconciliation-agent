/**
 * The two ways the BFF hands work to the pipeline's Lambdas.
 *
 * The parser is invoked asynchronously: parsing takes tens of seconds of model calls and the Inbox
 * polls the email's status instead of holding an HTTP request open. The mock OMS is invoked
 * synchronously: the approve button's response IS the upload verdict, and a validator that runs in
 * well under a second has no reason to be fire-and-forget.
 */

import { InvokeCommand } from "@aws-sdk/client-lambda";

import { lambda } from "./aws";

/** Fire-and-forget invocation. Resolves once Lambda has queued the event. */
export async function invokeAsync(
  functionName: string,
  payload: object,
): Promise<void> {
  await lambda().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

/**
 * Request/response invocation returning the function's parsed JSON result.
 *
 * @throws Error when the function itself raised (Lambda reports that as `FunctionError` with a 200
 *   status and the traceback in the payload, which would otherwise be mistaken for a result) or
 *   when the payload is not JSON.
 */
export async function invokeSync<T>(
  functionName: string,
  payload: object,
): Promise<T> {
  const resp = await lambda().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "";
  if (resp.FunctionError) {
    throw new Error(
      `${functionName} failed (${resp.FunctionError}): ${text.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${functionName} returned a non-JSON payload: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * The console layer's own Systems Manager client.
 *
 * Deliberately NOT imported from either app's AWS helper (`lib/pipeline/server/aws.ts`, or the recon
 * routes' per-file clients). The console layer sits above the apps: it decides which app a caller may
 * reach, so it must keep working — and keep building — on a deployment where one of them is absent or
 * broken. Importing an app's module would also drag that app's environment reader along, and a
 * missing `PIPELINE_ASSETS_BUCKET` has no business failing the access check.
 *
 * Built lazily, once per process: constructing an SDK client resolves the credential chain and region,
 * which is cheap but not free, and the proxy calls the console layer on every BFF request. Lazy rather
 * than at import so a test can set `AWS_REGION` first, and so a build that never touches SSM never
 * pays for it.
 */

import { SSMClient } from "@aws-sdk/client-ssm";

let client: SSMClient | undefined;

/**
 * The region every console SSM call is made in.
 *
 * Same convention as both apps: `AWS_REGION`, defaulting to `us-east-1`, because the ECS task
 * definition sets the variable and a laptop `.env.local` copies it from the Terraform outputs.
 */
function region(): string {
  return process.env.AWS_REGION?.trim() || "us-east-1";
}

/** The process-wide client, constructed on first use. */
export function consoleSsm(): SSMClient {
  if (!client) client = new SSMClient({ region: region() });
  return client;
}

/** Drop the cached client so the next call rebuilds it. For tests that swap the mock between cases. */
export function resetConsoleSsm(): void {
  client = undefined;
}

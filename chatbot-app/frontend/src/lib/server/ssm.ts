/**
 * The two Parameter Store calls the runtime-configuration routes and helpers share.
 *
 * Both apps keep their live switches in SSM parameters that a Lambda or an agent reads on every run.
 * Four callers used to inline the same dance -- `GetParameter`, treat `ParameterNotFound` as "nothing
 * recorded", rethrow anything else; and `PutParameter` as a `String` with `Overwrite` -- and now call
 * this module instead: `/api/recon/config` (five parameters), `/api/pipeline/config` (one),
 * `lib/agentSystemPrompt.ts` (the harness config pointer) and `lib/evalDataSource.ts` (the
 * agent-backend selector).
 *
 * Still on their own SDK calls, deliberately: the recon harness-config routes (which read and move the
 * same pointer but treat every read failure, not only an absent parameter, as "nothing deployed"), the
 * recon case routes (which load the SDK lazily on the one request path that needs the
 * comment-requirement mode), and the console layer (`lib/console/ssm.ts`, which also pages
 * `GetParametersByPath` and deletes, and must keep working on a deployment where an app is absent).
 * Each of the recon ones is a further mechanical change under its own route tests; none was in the
 * scope this module was introduced for.
 *
 * Neutral on purpose: nothing from either app or from the console layer is imported, so any route can
 * depend on it without depending on another app.
 *
 * One client per process, built on first use: constructing an SDK client resolves the credential chain
 * and region, which is cheap but not free. Lazy rather than at import so a test can set `AWS_REGION`
 * before the first call and so a build that never touches SSM never pays for it. The region convention
 * is the one every AWS client in this BFF follows: `AWS_REGION`, blank read as unset, `us-east-1`
 * otherwise, because the ECS task definition sets the variable and a laptop `.env.local` copies it from
 * the Terraform outputs.
 */

import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

let client: SSMClient | undefined;

function ssm(): SSMClient {
  if (!client) {
    client = new SSMClient({
      region: process.env.AWS_REGION?.trim() || "us-east-1",
    });
  }
  return client;
}

/** Whether an SDK error is the service saying the parameter does not exist. */
function isParameterNotFound(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "ParameterNotFound";
}

/**
 * Read one parameter's value.
 *
 * Returned raw: callers trim, case-fold and validate for themselves, because what a blank or an
 * unknown value MEANS differs per parameter (a threshold of "off", a backend that is neither known id,
 * a model outside the allowlist).
 *
 * @param name the full parameter name.
 * @returns the stored value, or null when the parameter does not exist.
 * @throws any other SDK failure (access denied, throttling, a bad region) unchanged, so a caller that
 *   must fail loudly can and a caller that must not can catch it.
 */
export async function readParam(name: string): Promise<string | null> {
  try {
    const got = await ssm().send(new GetParameterCommand({ Name: name }));
    return got.Parameter?.Value ?? null;
  } catch (err) {
    if (isParameterNotFound(err)) return null;
    throw err;
  }
}

/**
 * Create or overwrite one `String` parameter.
 *
 * @param name the full parameter name.
 * @param value the value to store, exactly as given.
 * @throws any SDK failure unchanged.
 */
export async function writeParam(name: string, value: string): Promise<void> {
  await ssm().send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: "String",
      Overwrite: true,
    }),
  );
}

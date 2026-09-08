/**
 * Read the document pipeline's GraphQL API as the ECS task role.
 *
 * Server-side only. The endpoint and the signing credentials never reach the browser — that is the
 * whole reason the Documents tab talks to a same-origin route instead of calling the API directly.
 *
 * Only reads go through here. The upload mutation on that API is restricted to interactive users by
 * group membership, so a machine caller cannot invoke it however it signs, and nothing in this file
 * pretends otherwise.
 *
 * Modelled on `gatewayMcp.ts`, which signs the same way for a different service: SignatureV4 over a
 * single POST, credentials from the node provider chain, SHA-256 from `@aws-crypto`.
 */

const REGION = process.env.AWS_REGION ?? "us-east-1";

/**
 * Run one GraphQL operation and return its `data` payload.
 *
 * @param query - the GraphQL document.
 * @param variables - operation variables; pass `{}` when there are none.
 * @returns the `data` object, typed by the caller.
 * @throws Error when `IDP_APPSYNC_ENDPOINT` is unset, the HTTP call fails, or the response carries
 *   GraphQL errors.
 */
export async function idpGraphQL<T>({
  query,
  variables,
}: {
  query: string;
  variables: Record<string, unknown>;
}): Promise<T> {
  // No fallback and no localhost guess. A defaulted endpoint would sign a request to nowhere and the
  // failure would read like the document pipeline being down, which is a different problem to chase.
  const endpointRaw = process.env.IDP_APPSYNC_ENDPOINT;
  if (!endpointRaw)
    throw new Error(
      "IDP_APPSYNC_ENDPOINT is not configured — the document pipeline's GraphQL endpoint must be set for the Documents tab to read anything",
    );

  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const { fromNodeProviderChain } =
    await import("@aws-sdk/credential-providers");

  const endpoint = new URL(endpointRaw);
  const body = JSON.stringify({ query, variables });
  const signer = new SignatureV4({
    service: "appsync",
    region: REGION,
    credentials: fromNodeProviderChain(),
    sha256: Sha256,
  });
  const signed = await signer.sign({
    method: "POST",
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: endpoint.pathname,
    headers: {
      host: endpoint.hostname,
      "content-type": "application/json",
    },
    body,
  });

  const resp = await fetch(endpoint.toString(), {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
  });
  const raw = await resp.text();
  if (!resp.ok)
    throw new Error(`IDP GraphQL HTTP ${resp.status}: ${raw.slice(0, 300)}`);

  const payload = JSON.parse(raw) as {
    data?: T;
    errors?: { message?: string }[];
  };

  // A GraphQL failure arrives as HTTP 200 with `{"data": null, "errors": [...]}`. A transport that
  // only checked `resp.ok` would report "not allowed" and "field does not exist" both as an empty
  // document list — the two states the tab most needs to tell apart from "no documents yet".
  if (payload.errors && payload.errors.length > 0)
    throw new Error(
      `IDP GraphQL error: ${payload.errors[0]?.message ?? "unspecified"}`,
    );

  // `data` absent with no errors would mean a malformed response, not an empty result; an empty
  // result is `{"data": {"listDocuments": null}}` and reaches the caller intact.
  if (payload.data === undefined || payload.data === null)
    throw new Error("IDP GraphQL returned no data and no errors");

  return payload.data;
}

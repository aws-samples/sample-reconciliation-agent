// Shared SigV4 MCP client for calling egress-gateway tools from the BFF routes.
//
// Every platform tool call (resolution email, the recon-status workflow tool, the
// Policy-gated ledger write) goes through this one transport: a JSON-RPC tools/call POST to
// <RECON_GATEWAY_URL>/mcp, SigV4-signed with the ECS task role (the gateway's inbound auth
// is AWS_IAM). Routing through the gateway — instead of hitting tool Lambdas or DynamoDB
// directly — is what makes the AgentCore Policy engine and the gateway REQUEST interceptor
// apply to human/BFF actions the same way they apply to the agent.

const REGION = process.env.AWS_REGION ?? "us-east-1";
const RECON_GATEWAY_URL = process.env.RECON_GATEWAY_URL ?? "";

export interface GatewayToolResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
  [key: string]: unknown;
}

// GetGateway returns the bare host; the MCP streamable-HTTP transport lives at /mcp.
export function mcpEndpoint(gatewayUrl: string): URL {
  const base = gatewayUrl.replace(/\/$/, "");
  return new URL(base.endsWith("/mcp") ? base : `${base}/mcp`);
}

// One signed JSON-RPC round trip to the gateway's MCP endpoint. Shared by tools/call and
// tools/list so both use the same SigV4 signing, SSE-or-JSON parsing, and loud failures.
async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  if (!RECON_GATEWAY_URL) {
    throw new Error("RECON_GATEWAY_URL is not configured");
  }
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const { fromNodeProviderChain } =
    await import("@aws-sdk/credential-providers");

  const endpoint = mcpEndpoint(RECON_GATEWAY_URL);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
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
      // The gateway's streamable-HTTP transport requires both accept types.
      accept: "application/json, text/event-stream",
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
    throw new Error(
      `gateway ${label} HTTP ${resp.status}: ${raw.slice(0, 300)}`,
    );
  // Streamable-HTTP may answer as SSE ("data: {...}") or plain JSON — parse either.
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : raw);
  if (payload.error)
    throw new Error(
      `gateway ${method} failed: ${JSON.stringify(payload.error)}`,
    );
  return (payload.result ?? {}) as Record<string, unknown>;
}

// Call one gateway tool ({target}___{operation}) and return the JSON-RPC result object.
// Throws on HTTP, JSON-RPC, or tool (isError) failures — including Policy denials and
// interceptor rejections — so callers fail loudly.
export async function callGatewayTool(
  name: string,
  args: Record<string, unknown>,
): Promise<GatewayToolResult> {
  const result = (await mcpRequest(
    "tools/call",
    { name, arguments: args },
    name,
  )) as GatewayToolResult;
  if (result.isError)
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result;
}

export interface GatewayTool {
  name: string;
  description: string;
}

/**
 * List the tools the gateway exposes, with their current descriptions.
 *
 * This is the authoritative source for a TOOL_DESCRIPTION_RECOMMENDATION input: the descriptions
 * the optimizer sharpens are exactly the ones the agent's model sees, and the gateway's
 * tools/list is what the model is given. Follows the MCP pagination cursor so a gateway with
 * more targets than one page cannot silently contribute a partial tool set.
 *
 * @returns one entry per tool ({name, description}), in gateway order.
 * @throws if the gateway is unreachable, unauthorized, or returns no tools.
 */
export async function listGatewayTools(): Promise<GatewayTool[]> {
  const tools: GatewayTool[] = [];
  let cursor: string | undefined;
  // Bounded loop: a server that keeps echoing a cursor must not spin this request forever.
  for (let page = 0; page < 20; page += 1) {
    const result = await mcpRequest(
      "tools/list",
      cursor ? { cursor } : {},
      "tools/list",
    );
    for (const t of (result.tools ?? []) as Array<Record<string, unknown>>) {
      if (typeof t.name === "string") {
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
        });
      }
    }
    cursor =
      typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  if (tools.length === 0) {
    throw new Error("gateway tools/list returned no tools");
  }
  return tools;
}

import { NextResponse } from "next/server";

// Same-origin BFF: submit a hand-written reconciliation payload into the pipeline. Used by the
// queue's "Create New" action so the two-tier flow (Tier-1 deterministic -> Tier-2 agent) can be
// exercised with no upstream IDP accelerator.
//
// This route does NOT write DynamoDB. It invokes the intake Lambda, which owns the pydantic
// validation and the conditional put — duplicating either here would let the UI accept a payload
// the pipeline rejects. The checks below are only the cheap ones that let us fail before spending a
// Lambda invoke, and the item cap.
//
// Authorization comes from `src/proxy.ts`, which verifies every `/api/recon/*` request before the
// handler runs. Nothing here needs the caller's identity — intake records no submitter — so unlike
// the draft/case routes this one does not call `authorizeRequest` itself.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const INTAKE_FUNCTION = process.env.INTAKE_FUNCTION ?? "";
// A single submission is an operator typing into a textarea. The cap exists so a paste of a
// production extract cannot fan out thousands of agent invocations from one click.
const MAX_ITEMS = 25;

export async function POST(req: Request) {
  if (!INTAKE_FUNCTION) {
    return NextResponse.json(
      { error: "intake is not configured (INTAKE_FUNCTION unset)" },
      { status: 500 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const { domain, items } = (body ?? {}) as {
    domain?: unknown;
    items?: unknown;
  };
  if (typeof domain !== "string" || !domain.trim()) {
    return NextResponse.json(
      { error: "`domain` (non-empty string) is required" },
      { status: 400 },
    );
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: "`items` (non-empty array) is required" },
      { status: 400 },
    );
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `at most ${MAX_ITEMS} items per submission` },
      { status: 400 },
    );
  }

  const { LambdaClient, InvokeCommand } =
    await import("@aws-sdk/client-lambda");
  // RequestResponse (not Event): the operator needs intake's 400 + pydantic message surfaced.
  // The other invoke in this BFF (case retry) uses Event because it wants fire-and-forget.
  const resp = await new LambdaClient({ region: REGION }).send(
    new InvokeCommand({
      FunctionName: INTAKE_FUNCTION,
      InvocationType: "RequestResponse",
      // Intake is an API Gateway proxy handler reading `event["body"]`, so the payload is the
      // event envelope rather than the payload itself.
      Payload: new TextEncoder().encode(
        JSON.stringify({
          body: JSON.stringify({ domain: domain.trim(), items }),
        }),
      ),
    }),
  );
  const raw = new TextDecoder().decode(resp.Payload ?? new Uint8Array());
  if (resp.FunctionError) {
    // An unhandled exception in intake — surface it rather than reporting a fake success. Truncated
    // because the payload is a Python traceback, not something a toast can hold.
    return NextResponse.json(
      { error: `intake failed: ${raw.slice(0, 500)}` },
      { status: 502 },
    );
  }
  let parsed: { statusCode?: number; body?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: `unparseable intake response: ${raw.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const status = parsed.statusCode ?? 502;
  let payload: unknown = {};
  if (parsed.body) {
    try {
      payload = JSON.parse(parsed.body);
    } catch {
      return NextResponse.json(
        { error: `unparseable intake body: ${parsed.body.slice(0, 200)}` },
        { status: 502 },
      );
    }
  }
  // 202 from intake = accepted; pass its {written} count straight through.
  return NextResponse.json(payload, { status: status === 202 ? 200 : status });
}

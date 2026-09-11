import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import {
  getEmail,
  markInvokeFailed,
  markParsing,
} from "@/lib/pipeline/server/emailStore";
import { isConditionalCheckFailed } from "@/lib/pipeline/server/aws";
import { env } from "@/lib/pipeline/server/env";
import { jsonError } from "@/lib/pipeline/server/http";
import { invokeAsync } from "@/lib/pipeline/server/lambdaInvoke";

// Run the parser again on an email — after a skill or memory change, or after a failure.
//
// Not admin-gated: reparsing creates a new STAGED deal that still needs a reviewer's approval, so
// it changes nothing the OMS sees. The parser supersedes any open deal already linked from the
// email when it stages the new one; the BFF does not touch the previous deal.
//
// One parser run per email at a time. A second reparse while one is in flight would have two runs
// each mint a deal and race on the email row, leaving one deal no email points at — so a PARSING
// email answers 409, and the PARSING write itself is conditional for the two requests that both
// read a settled status.
export const runtime = "nodejs";

/**
 * @returns 202 with the email marked PARSING; 404 unknown id; 409 while a parser run is already in
 *   flight; 502 when the parser could not be invoked.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const { id } = await params;
  try {
    const email = await getEmail(id);
    if (!email) return jsonError(404, `email ${id} not found`);
    if (email.status === "PARSING") {
      return jsonError(409, `email ${id} is already being parsed; wait for it to finish`);
    }
    const parsing = await markParsing(email);
    try {
      await invokeAsync(env.parserFunction(), { email_id: id });
    } catch (err) {
      const failed = await markInvokeFailed(parsing, (err as Error).message);
      return jsonError(502, failed.error ?? "parser invoke failed", { email: failed });
    }
    return NextResponse.json(parsing, { status: 202 });
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // Another reparse won the write between our read and ours; its run is the one in flight.
      return jsonError(409, `email ${id} is already being parsed; wait for it to finish`);
    }
    return jsonError(500, `reparse failed: ${(err as Error).message}`);
  }
}

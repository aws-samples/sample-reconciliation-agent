import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import type { SourceKind } from "@/lib/pipeline/types";
import {
  createEmail,
  listEmails,
  markInvokeFailed,
  type NewEmailInput,
} from "@/lib/pipeline/server/emailStore";
import { env } from "@/lib/pipeline/server/env";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { invokeAsync } from "@/lib/pipeline/server/lambdaInvoke";
import {
  parseCreateEmailBody,
  type CreateEmailRequest,
} from "@/lib/pipeline/server/requests";
import { getSample } from "@/lib/pipeline/server/samples";

// The inbox (design §9): list received emails, or simulate one arriving.
//
// POST is the pipeline's trigger. It creates the email row, stores the raw message in S3 and
// hands the id to the parser Lambda asynchronously; the Inbox then polls the row's status as the
// parser moves it RECEIVED → PARSING → PARSED. 202 rather than 201 because the thing the caller
// wants — a parsed deal — is not there yet.
export const runtime = "nodejs";

/** @returns every email, newest first. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    return NextResponse.json(await listEmails());
  } catch (err) {
    return jsonError(500, `emails list failed: ${(err as Error).message}`);
  }
}

/**
 * Simulate an incoming email and start parsing it.
 *
 * @returns 202 with the RECEIVED email; 400 on a bad body; 404 for an unknown `sample_id`; 502 when
 *   the parser could not be invoked (the email is then stored as PARSE_FAILED with the reason, so
 *   the Inbox shows it and Reparse can retry).
 */
export async function POST(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;

  let request: CreateEmailRequest;
  try {
    request = parseCreateEmailBody(await readJsonObject(req));
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  let input: NewEmailInput;
  if ("sample_id" in request) {
    const sample = await getSample(request.sample_id);
    if (!sample) return jsonError(404, `unknown sample_id ${request.sample_id}`);
    input = {
      source_kind: sample.source_kind,
      from: sample.from,
      to: sample.to,
      cc: sample.cc,
      subject: sample.subject,
      sent: sample.sent,
      body: sample.body,
      sample_id: sample.id,
    };
  } else {
    const now = new Date().toISOString();
    const manual: SourceKind = "manual";
    input = {
      source_kind: manual,
      from: request.raw.from,
      to: request.raw.to ?? "",
      cc: request.raw.cc,
      subject: request.raw.subject,
      sent: request.raw.sent ?? now,
      body: request.raw.body,
      sample_id: null,
    };
  }

  try {
    const email = await createEmail(input);
    try {
      await invokeAsync(env.parserFunction(), { email_id: email.email_id });
    } catch (err) {
      const failed = await markInvokeFailed(email, (err as Error).message);
      return jsonError(502, failed.error ?? "parser invoke failed", { email: failed });
    }
    return NextResponse.json(email, { status: 202 });
  } catch (err) {
    return jsonError(500, `email create failed: ${(err as Error).message}`);
  }
}

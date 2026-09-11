import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { jsonError } from "@/lib/pipeline/server/http";
import { listChatEvents } from "@/lib/pipeline/server/memoryClient";
import { SESSION_ID } from "@/lib/pipeline/server/requests";

// A chat session's transcript from the short-term memory, so a reload does not lose the thread.
// Scoped to the verified caller: sessions are keyed on the actor, so nobody can read another
// person's conversation by guessing its id.
export const runtime = "nodejs";

/** @returns `{ session_id, messages }`; `messages` is `[]` when the chat memory is not configured. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!SESSION_ID.test(sessionId)) {
    return jsonError(400, "session_id query parameter is required");
  }
  try {
    const messages = await listChatEvents(sessionId, who.actor);
    return NextResponse.json({ session_id: sessionId, messages });
  } catch (err) {
    return jsonError(500, `chat history failed: ${(err as Error).message}`);
  }
}

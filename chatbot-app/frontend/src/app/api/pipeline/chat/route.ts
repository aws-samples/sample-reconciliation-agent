import { requirePipelineActor } from "@/lib/pipelineAdmin";
import type { ChatStreamEvent } from "@/lib/pipeline/types";
import { runAssistantTurn } from "@/lib/pipeline/server/chatAgent";
import { jsonError, readJsonObject } from "@/lib/pipeline/server/http";
import { parseChatBody, type ChatRequest } from "@/lib/pipeline/server/requests";

// The assistant, as a server-sent event stream (design §7, §9).
//
// One POST is one user turn. The response is `text/event-stream`: each protocol event is one
// `data:` line, and a comment line goes out every 15 seconds so a proxy or browser that idles the
// connection during a long tool call does not drop it. When the browser disconnects, the model
// call is aborted rather than left to finish — a tool round the user will never see costs money
// and, for the write tools, might act.
//
// Open to every authenticated user, but the caller's admin-group membership travels into the turn:
// the memory-writing tools are the same writes as the admin-gated `/memory` routes, and a gate the
// assistant could walk around would protect nothing.
export const runtime = "nodejs";

const KEEP_ALIVE_MS = 15_000;

/** One SSE frame for a protocol event. */
function frame(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: Request) {
  const who = await requirePipelineActor(req);
  if ("error" in who) return who.error;

  let body: ChatRequest;
  try {
    body = parseChatBody(await readJsonObject(req));
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Enqueue after close throws; the client may vanish between any two events.
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          abort.abort();
        }
      };
      send(`: connected ${new Date().toISOString()}\n\n`);
      const keepAlive = setInterval(
        () => send(`: keep-alive ${new Date().toISOString()}\n\n`),
        KEEP_ALIVE_MS,
      );
      const onAbort = () => abort.abort();
      req.signal.addEventListener("abort", onAbort);
      try {
        for await (const event of runAssistantTurn({
          sessionId: body.session_id,
          message: body.message,
          context: body.context,
          actor: who.actor,
          canWrite: who.isAdmin,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted) break;
          send(frame(event));
        }
      } catch (err) {
        // The generator reports model and tool failures itself; this catches anything before it
        // started (prompt load, memory read), which still deserves a readable line in the chat.
        send(frame({ type: "error", message: (err as Error).message }));
      } finally {
        clearInterval(keepAlive);
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables response buffering in nginx-style proxies, which would otherwise hold the deltas.
      "X-Accel-Buffering": "no",
    },
  });
}

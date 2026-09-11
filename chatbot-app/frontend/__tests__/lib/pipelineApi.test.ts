/**
 * The pipeline BFF client: the one error path every call shares, and the SSE reader the assistant
 * depends on. Both are the kind of code that works on the happy path and fails on the boundary — a
 * non-JSON 502, a chunk split in the middle of a JSON frame — so that is what these pin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pipelineFetch = vi.fn();
vi.mock("@/lib/pipeline-auth", () => ({
  pipelineFetch: (...args: unknown[]) => pipelineFetch(...args),
}));

import {
  approveDeal,
  deleteMemory,
  getDealCsv,
  json,
  listEmails,
  listProposals,
  readSseStream,
  streamChat,
} from "@/lib/pipelineApi";
import type { ChatStreamEvent } from "@/lib/pipeline/types";

/** A minimal Response stand-in: the client only ever reads `ok`, `status`, `json()`, `text()`, `body`. */
function response(
  status: number,
  body: unknown,
  opts: { raw?: boolean } = {},
): Response {
  const text = opts.raw ? String(body) : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** A body stream that yields the given chunks in order, as bytes. */
function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { value: encoder.encode(chunks[i++]), done: false as const }
          : { value: undefined, done: true as const },
    }),
  } as unknown as ReadableStream<Uint8Array>;
}

beforeEach(() => {
  pipelineFetch.mockReset();
});

describe("json()", () => {
  it("returns the parsed body on success", async () => {
    expect(await json(response(200, { a: 1 }))).toEqual({ a: 1 });
  });

  it("resolves to undefined on an empty 2xx body rather than failing to parse", async () => {
    expect(await json(response(204, "", { raw: true }))).toBeUndefined();
  });

  it("throws the server's own error message when the body carries one", async () => {
    await expect(
      json(response(403, { error: 'this endpoint requires membership of the "deal-desk-admins" group' })),
    ).rejects.toThrow('requires membership of the "deal-desk-admins" group');
  });

  it("falls back to the status when the error body is not JSON", async () => {
    // A proxy error page or an empty 502 must still produce a readable message, not "Unexpected token".
    await expect(json(response(502, "<html>bad gateway</html>", { raw: true }))).rejects.toThrow(
      "pipeline API error 502",
    );
  });

  it("falls back to the status when the JSON error body has no `error` string", async () => {
    await expect(json(response(500, { message: "nope" }))).rejects.toThrow("pipeline API error 500");
  });
});

describe("list routes", () => {
  it("accepts a bare array", async () => {
    pipelineFetch.mockResolvedValue(response(200, [{ email_id: "em_1" }]));
    expect(await listEmails()).toEqual([{ email_id: "em_1" }]);
    expect(pipelineFetch).toHaveBeenCalledWith("/api/pipeline/emails");
  });

  it("accepts an envelope keyed by the collection name", async () => {
    pipelineFetch.mockResolvedValue(response(200, { emails: [{ email_id: "em_2" }] }));
    expect(await listEmails()).toEqual([{ email_id: "em_2" }]);
  });

  it("filters proposals by status client-side as well as asking the server", async () => {
    // A route that ignores the query must not leak APPROVED rows into the PENDING view.
    pipelineFetch.mockResolvedValue(
      response(200, [
        { proposal_id: "p1", status: "PENDING" },
        { proposal_id: "p2", status: "APPROVED" },
      ]),
    );
    const pending = await listProposals("PENDING");
    expect(pending.map((p) => p.proposal_id)).toEqual(["p1"]);
    expect(pipelineFetch).toHaveBeenCalledWith("/api/pipeline/skills/proposals?status=PENDING");
  });
});

describe("single-record routes", () => {
  it("POSTs approve with no body and returns the updated deal", async () => {
    pipelineFetch.mockResolvedValue(response(200, { deal_id: "dl_1", status: "UPLOAD_FAILED" }));
    const deal = await approveDeal("dl_1");
    expect(deal.status).toBe("UPLOAD_FAILED");
    expect(pipelineFetch).toHaveBeenCalledWith("/api/pipeline/deals/dl_1/approve", { method: "POST" });
  });

  it("returns the CSV as text and surfaces a failure through the shared error path", async () => {
    pipelineFetch.mockResolvedValueOnce(response(200, "A,B\n1,2\n", { raw: true }));
    expect(await getDealCsv("dl_1")).toBe("A,B\n1,2\n");

    pipelineFetch.mockResolvedValueOnce(response(404, { error: "deal not found" }));
    await expect(getDealCsv("dl_missing")).rejects.toThrow("deal not found");
  });

  it("treats a bodiless delete as every id deleted", async () => {
    pipelineFetch.mockResolvedValue(response(204, "", { raw: true }));
    expect(await deleteMemory(["m1", "m2"])).toEqual({ deleted: ["m1", "m2"], failed: [] });
  });
});

describe("readSseStream()", () => {
  it("dispatches one event per data: line, in order, across arbitrary chunk boundaries", async () => {
    const events: ChatStreamEvent[] = [];
    await readSseStream(
      stream([
        'data: {"type":"text","del',
        'ta":"Hel"}\ndata: {"type":"text","delta":"lo"}\n',
        ': keep-alive comment\n\n',
        'event: tool\ndata: {"type":"tool_call","name":"get_deal","input":{"deal_id":"dl_1"}}\r\n',
        'data: {"type":"tool_result","name":"get_deal","ok":true,"summary":"1 deal"}\n',
        'data: {"type":"done","session_id":"s1"}',
      ]),
      (e) => events.push(e),
    );

    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "tool_call", name: "get_deal", input: { deal_id: "dl_1" } },
      { type: "tool_result", name: "get_deal", ok: true, summary: "1 deal" },
      // The final frame had no trailing newline; it must still arrive.
      { type: "done", session_id: "s1" },
    ]);
  });

  it("turns an unparseable frame into an error event instead of throwing", async () => {
    const events: ChatStreamEvent[] = [];
    await readSseStream(stream(["data: {not json}\n", 'data: {"type":"done","session_id":"s"}\n']), (e) =>
      events.push(e),
    );
    expect(events[0].type).toBe("error");
    expect(events[1]).toEqual({ type: "done", session_id: "s" });
  });
});

describe("streamChat()", () => {
  it("posts the turn and streams the reply", async () => {
    pipelineFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: stream(['data: {"type":"text","delta":"hi"}\n', 'data: {"type":"done","session_id":"s1"}\n']),
    });
    const events: ChatStreamEvent[] = [];
    await streamChat(
      { session_id: "s1", message: "why did it fail?", context: { deal_id: "dl_1" } },
      (e) => events.push(e),
    );

    const [url, init] = pipelineFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/pipeline/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      session_id: "s1",
      message: "why did it fail?",
      context: { deal_id: "dl_1" },
    });
    expect(events).toEqual([
      { type: "text", delta: "hi" },
      { type: "done", session_id: "s1" },
    ]);
  });

  it("throws the server's message on a non-2xx response before dispatching anything", async () => {
    pipelineFetch.mockResolvedValue(response(503, { error: "ASSISTANT_MODEL_ID is not configured" }));
    const onEvent = vi.fn();
    await expect(streamChat({ session_id: "s", message: "m" }, onEvent)).rejects.toThrow(
      "ASSISTANT_MODEL_ID is not configured",
    );
    expect(onEvent).not.toHaveBeenCalled();
  });
});

/**
 * Request and Response stand-ins for route-handler and BFF-client tests.
 *
 * Replaces the `get` / `post` / `put` / `del` / `req` / `json` builders that each API test wrote
 * around `new Request(url, { method, headers: { "Content-Type": "application/json" }, body:
 * JSON.stringify(body) })`, the `params(id)` wrapper for the App Router's second handler argument,
 * and the `response` / `jsonResponse` objects the client tests fed `fetch` mocks.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */

export interface JsonRequestInit {
  /** Extra headers, e.g. an `Authorization` header. */
  headers?: Record<string, string>;
  /** Send `body` as the raw string given, not JSON-encoded — for malformed-body cases. */
  raw?: boolean;
}

/**
 * A `Request` carrying `body` as JSON. With no body there is no body and no `Content-Type`, so a
 * `GET` or a body-less `POST` looks the way a browser sends it. (The inline builders this replaced
 * always sent `Content-Type: application/json`; no route under test reads that header, so the
 * more realistic shape is deliberate.)
 */
export function jsonRequest(method: string, url: string, body?: unknown, init: JsonRequestInit = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    payload = init.raw ? (body as string) : JSON.stringify(body);
  }
  return new Request(url, { method, headers, body: payload });
}

/** The App Router's second handler argument: `{ params: Promise.resolve({ id }) }`. */
export function routeParams<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

export interface FakeResponseInit {
  /** Serve `body` as the raw text given, not JSON-encoded — for non-JSON failure bodies. */
  raw?: boolean;
  /** What `res.statusText` reports; the shell falls back to it when a failure body is not JSON. */
  statusText?: string;
}

/**
 * A minimal `Response`: `ok`, `status`, `statusText`, `json()` and `text()` — all the BFF clients and
 * the shell read. An `undefined` body is an empty one, as on a 204.
 */
export function fakeResponse(status: number, body: unknown, init: FakeResponseInit = {}): Response {
  const text = init.raw ? String(body) : body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? "",
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** Tests for POST /api/recon/items — manual payload submission via the intake Lambda. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send })),
  InvokeCommand: vi.fn().mockImplementation((args) => args),
}));

const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const post = (body: unknown) =>
  new Request("http://localhost:3000/api/recon/items", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** INTAKE_FUNCTION is read into a module-level const, so the module must be re-imported per case. */
const loadRoute = async () => {
  vi.resetModules();
  return import("@/app/api/recon/items/route");
};

describe("POST /api/recon/items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTAKE_FUNCTION = "recon-dev-intake";
  });

  it("passes a valid payload to intake and returns its written count", async () => {
    send.mockResolvedValue({
      Payload: encode({
        statusCode: 202,
        body: JSON.stringify({ written: 1 }),
      }),
    });
    const { POST } = await loadRoute();
    const res = await POST(
      post({ domain: "cash", items: [{ item_id: "m-1", sides: [] }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 1 });
    // The Lambda receives an API-Gateway-shaped event, because intake reads event["body"].
    expect(send.mock.calls[0][0].InvocationType).toBe("RequestResponse");
    const sent = JSON.parse(
      new TextDecoder().decode(send.mock.calls[0][0].Payload as Uint8Array),
    );
    expect(JSON.parse(sent.body)).toEqual({
      domain: "cash",
      items: [{ item_id: "m-1", sides: [] }],
    });
  });

  it("trims the domain before handing it to intake", async () => {
    send.mockResolvedValue({
      Payload: encode({
        statusCode: 202,
        body: JSON.stringify({ written: 1 }),
      }),
    });
    const { POST } = await loadRoute();
    await POST(post({ domain: "  cash  ", items: [{ item_id: "m-1" }] }));
    const sent = JSON.parse(
      new TextDecoder().decode(send.mock.calls[0][0].Payload as Uint8Array),
    );
    expect(JSON.parse(sent.body).domain).toBe("cash");
  });

  it("surfaces intake's 400 and its message rather than reporting success", async () => {
    send.mockResolvedValue({
      Payload: encode({
        statusCode: 400,
        body: JSON.stringify({ error: "items must be non-empty" }),
      }),
    });
    const { POST } = await loadRoute();
    const res = await POST(post({ domain: "cash", items: [{ bogus: true }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("non-empty");
  });

  it("reports 502 when the intake Lambda itself errors", async () => {
    send.mockResolvedValue({
      FunctionError: "Unhandled",
      Payload: encode({ errorMessage: "boom" }),
    });
    const { POST } = await loadRoute();
    const res = await POST(
      post({ domain: "cash", items: [{ item_id: "m-2", sides: [] }] }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("boom");
  });

  it("reports 502 when intake's response is not JSON at all", async () => {
    send.mockResolvedValue({ Payload: new TextEncoder().encode("not json") });
    const { POST } = await loadRoute();
    const res = await POST(
      post({ domain: "cash", items: [{ item_id: "m-4" }] }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("unparseable");
  });

  it("reports 502 when intake's inner body is not JSON", async () => {
    // The inner body is a separately-encoded string, so it can be malformed while the envelope
    // parses. Left unguarded this throws inside the handler and Next.js renders a 500 with a stack.
    send.mockResolvedValue({
      Payload: encode({ statusCode: 202, body: "{oops" }),
    });
    const { POST } = await loadRoute();
    const res = await POST(
      post({ domain: "cash", items: [{ item_id: "m-5" }] }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("unparseable intake body");
  });

  it.each([
    [{ items: [{ item_id: "a" }] }, "domain"],
    [{ domain: "   ", items: [{ item_id: "a" }] }, "domain"],
    [{ domain: "cash" }, "items"],
    [{ domain: "cash", items: [] }, "items"],
    [
      {
        domain: "cash",
        items: Array.from({ length: 26 }, (_, i) => ({ item_id: `x${i}` })),
      },
      "25",
    ],
  ])("rejects %j with 400 without invoking intake", async (body, needle) => {
    const { POST } = await loadRoute();
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(needle as string);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON request body with 400", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request("http://localhost:3000/api/recon/items", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 500 when INTAKE_FUNCTION is unset", async () => {
    process.env.INTAKE_FUNCTION = "";
    const { POST } = await loadRoute();
    const res = await POST(
      post({ domain: "cash", items: [{ item_id: "m-3" }] }),
    );
    expect(res.status).toBe(500);
    expect(send).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
/**
 * The response envelope both route families share. What differs between the two families is the one
 * thing pinned here: the console's answers carry `Cache-Control: no-store`, the apps' do not.
 */
import { describe, expect, it } from "vitest";

import {
  jsonError,
  jsonErrorNoStore,
  jsonNoStore,
  readJson,
  readJsonObject,
  stringField,
} from "@/lib/server/http";
import {
  errorResponse,
  jsonError as consoleJsonError,
} from "@/lib/console/http";
import { ConsoleValidationError } from "@/lib/console/validation";

describe("error envelopes", () => {
  it("jsonError carries the message and any extra fields, without a cache header", async () => {
    const resp = jsonError(422, "invalid", { problems: ["x"] });
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ error: "invalid", problems: ["x"] });
    expect(resp.headers.get("cache-control")).toBeNull();
  });

  it("the console's jsonError is the no-store variant", async () => {
    const resp = consoleJsonError(403, "console admins only");
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ error: "console admins only" });
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(jsonErrorNoStore(400, "bad").headers.get("cache-control")).toBe(
      "no-store",
    );
    expect(jsonNoStore({ ok: true }).headers.get("cache-control")).toBe(
      "no-store",
    );
  });

  it("errorResponse maps the console's own error classes onto their statuses", async () => {
    expect(
      errorResponse(new ConsoleValidationError("group name too long")).status,
    ).toBe(400);
    const other = errorResponse(new Error("boom"));
    expect(other.status).toBe(500);
    expect((await other.json()).error).toBe("console settings failed: boom");
    expect(other.headers.get("cache-control")).toBe("no-store");
  });
});

describe("body readers", () => {
  const req = (body: string) =>
    new Request("http://x/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

  it("readJson tells parsed-null apart from unparseable", async () => {
    expect(await readJson(req("null"))).toEqual({ ok: true, body: null });
    expect(await readJson(req("{nope"))).toEqual({ ok: false });
  });

  it("readJsonObject collapses absent, malformed and non-object bodies to null", async () => {
    expect(await readJsonObject(req('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJsonObject(req("[]"))).toBeNull();
    expect(await readJsonObject(req('"x"'))).toBeNull();
    expect(await readJsonObject(req("{nope"))).toBeNull();
  });

  it("stringField trims and treats blank as absent", () => {
    expect(stringField({ a: "  x " }, "a")).toBe("x");
    expect(stringField({ a: "   " }, "a")).toBeUndefined();
    expect(stringField({ a: 7 }, "a")).toBeUndefined();
  });
});

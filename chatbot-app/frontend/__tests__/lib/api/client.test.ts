/**
 * The JSON core the three BFF clients share. One error path for every call — the kind of code that
 * works on the happy path and fails on the boundary (a non-JSON 502, an empty 204, an `error` field
 * that is not a string) — so that is what these pin, under each client's label.
 */
import { describe, expect, it } from "vitest";

import { jsonInit, listOf, parseJsonResponse } from "@/lib/api/client";

import { fakeResponse } from "../../helpers/http";

describe("parseJsonResponse()", () => {
  it("returns the parsed body on success", async () => {
    expect(
      await parseJsonResponse(fakeResponse(200, { a: 1 }), "recon API"),
    ).toEqual({ a: 1 });
  });

  it("resolves to undefined on an empty 2xx body rather than failing to parse", async () => {
    expect(
      await parseJsonResponse(fakeResponse(204, "", { raw: true }), "pipeline API"),
    ).toBeUndefined();
    expect(
      await parseJsonResponse(fakeResponse(204, undefined), "console API"),
    ).toBeUndefined();
  });

  it("throws the server's own error message when the body carries one", async () => {
    await expect(
      parseJsonResponse(
        fakeResponse(403, {
          error:
            'this endpoint requires membership of the "deal-desk-admins" group',
        }),
        "pipeline API",
      ),
    ).rejects.toThrow('requires membership of the "deal-desk-admins" group');
    await expect(
      parseJsonResponse(
        fakeResponse(403, {
          error: "console settings require the console-admins group",
        }),
        "console API",
      ),
    ).rejects.toThrow("console settings require the console-admins group");
  });

  it.each(["recon API", "pipeline API", "console API"])(
    "falls back to `%s error <status>` when the error body is not JSON",
    async (label) => {
      // A proxy error page or an empty 502 must still produce a readable message, not "Unexpected token".
      await expect(
        parseJsonResponse(
          fakeResponse(502, "<html>bad gateway</html>", { raw: true }),
          label,
        ),
      ).rejects.toThrow(`${label} error 502`);
    },
  );

  it("falls back to the status when the JSON error body has no `error` string", async () => {
    await expect(
      parseJsonResponse(fakeResponse(500, { message: "nope" }), "pipeline API"),
    ).rejects.toThrow("pipeline API error 500");
    await expect(
      parseJsonResponse(fakeResponse(500, { detail: "x" }), "console API"),
    ).rejects.toThrow("console API error 500");
    // An `error` that is present but not a string must not become "[object Object]" or "42".
    await expect(
      parseJsonResponse(fakeResponse(500, { error: { code: 42 } }), "recon API"),
    ).rejects.toThrow("recon API error 500");
    await expect(
      parseJsonResponse(fakeResponse(500, { error: "" }), "recon API"),
    ).rejects.toThrow("recon API error 500");
  });
});

describe("listOf()", () => {
  it("accepts a bare array, an envelope under the named key, and nothing else", () => {
    expect(listOf([1, 2], "items")).toEqual([1, 2]);
    expect(listOf({ items: [3] }, "items")).toEqual([3]);
    expect(listOf({ other: [3] }, "items")).toEqual([]);
    expect(listOf(undefined, "items")).toEqual([]);
  });
});

describe("jsonInit()", () => {
  it("serialises the body under a JSON content type", () => {
    expect(jsonInit("PUT", { a: 1 })).toEqual({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
  });
});

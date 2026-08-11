import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildLoginUrl, exchangeCode } from "@/lib/auth";

describe("cognito oauth (code + PKCE)", () => {
  beforeEach(() => {
    // jsdom provides sessionStorage and crypto.subtle; ensure a clean verifier slot.
    sessionStorage.clear();
  });

  it("buildLoginUrl targets the Hosted UI with code flow and PKCE challenge", async () => {
    const url = await buildLoginUrl();
    expect(url).toContain("/oauth2/authorize");
    expect(url).toContain("response_type=code");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("code_challenge_method=S256");
  });

  it("exchangeCode POSTs the code to the token endpoint and returns tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "at", id_token: "it" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const tok = await exchangeCode("auth-code-123");
    expect(tok.access_token).toBe("at");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/oauth2/token"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

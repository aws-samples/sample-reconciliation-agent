/**
 * Tests for auth-utils.ts
 *
 * Tests cover:
 * - JWT token extraction from Authorization header
 * - User ID extraction from Microsoft Entra ID tokens (oid claim)
 * - Session ID generation and validation
 * - Error handling for invalid tokens
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractUserFromRequest, getSessionId } from "@/lib/auth-utils";

// Helper to create a mock JWT token
function createMockJWT(payload: Record<string, any>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64");
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64");
  const signature = "mock-signature";
  return `${header}.${payloadStr}.${signature}`;
}

// Helper to create a mock Request
function createMockRequest(headers: Record<string, string> = {}): Request {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] || null,
    },
  } as unknown as Request;
}

describe("extractUserFromRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Authorization Header Handling", () => {
    it("should return anonymous when no Authorization header", () => {
      const request = createMockRequest({});

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });

    it("should return anonymous when Authorization header is empty", () => {
      const request = createMockRequest({ authorization: "" });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });

    it("should return anonymous when Authorization header does not start with Bearer", () => {
      const request = createMockRequest({ authorization: "Basic abc123" });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });

    it("should return anonymous for malformed Bearer token", () => {
      const request = createMockRequest({ authorization: "Bearer " });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });
  });

  describe("JWT Token Parsing", () => {
    it("should return anonymous for invalid JWT format (not 3 parts)", () => {
      const request = createMockRequest({
        authorization: "Bearer invalid.token",
      });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });

    it("should return anonymous for invalid base64 payload", () => {
      const request = createMockRequest({
        authorization: "Bearer header.!!!invalid!!!.signature",
      });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });

    it("should handle token with only sub claim", () => {
      const token = createMockJWT({ sub: "sub-only-user" });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("sub-only-user");
      expect(result.email).toBeUndefined();
      expect(result.username).toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty payload", () => {
      const token = createMockJWT({});
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("anonymous");
    });

    it("should handle token with special characters in claims", () => {
      const token = createMockJWT({
        sub: "user-with-special-chars-äöü",
        email: "test+special@example.com",
      });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("user-with-special-chars-äöü");
      expect(result.email).toBe("test+special@example.com");
    });
  });

  describe("Entra (Microsoft Entra ID) JWT Parsing", () => {
    const ENTRA_TENANT = "00000000-0000-0000-0000-000000000000";
    const ENTRA_APP_ID = "11111111-1111-1111-1111-111111111111";
    const ENTRA_ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`;

    it("should use oid (not sub) as userId for Entra tokens", () => {
      const token = createMockJWT({
        iss: ENTRA_ISSUER,
        aud: `api://${ENTRA_APP_ID}`,
        ver: "2.0",
        oid: "99999999-9999-9999-9999-999999999999",
        sub: "app-specific-sub-do-not-use", // app-specific, not stable across apps
        preferred_username: "alice@contoso.onmicrosoft.com",
        name: "Alice Anderson",
        scp: "access_as_user",
      });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("99999999-9999-9999-9999-999999999999");
      expect(result.email).toBe("alice@contoso.onmicrosoft.com");
      expect(result.username).toBe("alice@contoso.onmicrosoft.com");
    });

    it("should fall back to sub when oid is missing on Entra token", () => {
      // Some service-principal tokens lack oid; we still want a userId.
      const token = createMockJWT({
        iss: ENTRA_ISSUER,
        aud: `api://${ENTRA_APP_ID}`,
        sub: "fallback-sub",
        preferred_username: "svc@contoso.onmicrosoft.com",
      });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("fallback-sub");
    });

    it("should also detect v1 Entra issuer (sts.windows.net)", () => {
      // Entra v1 tokens carry iss = sts.windows.net/<tenant>/. We disambiguate
      // by the same hostname check; this token still wins the Entra branch.
      const token = createMockJWT({
        iss: `https://sts.windows.net/${ENTRA_TENANT}/`,
        aud: `api://${ENTRA_APP_ID}`,
        oid: "v1-oid-claim",
        upn: "bob@contoso.com",
      });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("v1-oid-claim");
    });

    it("should prefer email over preferred_username when both are present", () => {
      const token = createMockJWT({
        iss: ENTRA_ISSUER,
        oid: "oid-1",
        email: "alice.real@contoso.com",
        preferred_username: "alice@contoso.onmicrosoft.com",
      });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.email).toBe("alice.real@contoso.com");
      expect(result.username).toBe("alice@contoso.onmicrosoft.com");
    });

    it("should not be confused by Cognito sub on Entra-issued tokens", () => {
      // Defense in depth: even if a Cognito-shaped sub is present, the issuer
      // disambiguates and we still pick oid.
      const token = createMockJWT({
        iss: ENTRA_ISSUER,
        oid: "entra-oid",
        sub: "cognito-shaped-sub",
        "cognito:username": "should-be-ignored",
      });
      const request = createMockRequest({ authorization: `Bearer ${token}` });

      const result = extractUserFromRequest(request);

      expect(result.userId).toBe("entra-oid");
    });
  });
});

describe("getSessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock crypto.randomUUID
    vi.stubGlobal("crypto", {
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    });
  });

  describe("Existing Session ID", () => {
    it("should return existing session ID from header", () => {
      const existingSessionId = "existing-session-id-12345678901234567890";
      const request = createMockRequest({ "x-session-id": existingSessionId });

      const result = getSessionId(request, "user-123");

      expect(result.sessionId).toBe(existingSessionId);
      // Note: isNew is determined by ensureSessionExists, not getSessionId
    });

    it("should not generate new ID when header exists", () => {
      const request = createMockRequest({ "x-session-id": "existing-id" });

      const result = getSessionId(request, "user-123");

      expect(result.sessionId).toBe("existing-id");
    });
  });

  describe("New Session ID Generation", () => {
    it("should generate new session ID when header is missing", () => {
      const request = createMockRequest({});

      const result = getSessionId(request, "user-123");

      // Note: isNew is determined by ensureSessionExists, not getSessionId
      expect(result.sessionId).toBeTruthy();
    });

    it("should generate session ID >= 33 characters", () => {
      const request = createMockRequest({});

      const result = getSessionId(request, "user-123");

      expect(result.sessionId.length).toBeGreaterThanOrEqual(33);
    });

    it("should include user prefix for authenticated users", () => {
      const request = createMockRequest({});

      const result = getSessionId(request, "user-123-full-id");

      // Should start with first 8 chars of userId
      expect(result.sessionId.startsWith("user-123")).toBe(true);
    });

    it("should use anon0000 prefix for anonymous users", () => {
      const request = createMockRequest({});

      const result = getSessionId(request, "anonymous");

      expect(result.sessionId.startsWith("anon0000")).toBe(true);
    });

    it("should include timestamp in session ID", () => {
      const request = createMockRequest({});
      const beforeTime = Date.now();

      const result = getSessionId(request, "user-123");

      // Session ID format: userPrefix_timestamp_randomId
      const parts = result.sessionId.split("_");
      expect(parts.length).toBe(3);

      // Timestamp part should be base36 encoded
      const timestamp = parseInt(parts[1], 36);
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime - 1000);
    });

    it("should include random UUID in session ID", () => {
      const request = createMockRequest({});

      const result = getSessionId(request, "user-123");

      // Should contain the mocked UUID (without dashes)
      expect(result.sessionId).toContain("12345678123412341234123456789abc");
    });
  });

  describe("Session ID Format Validation", () => {
    it("should generate consistent format", () => {
      const request = createMockRequest({});

      const result = getSessionId(request, "testuser");

      // Format: userPrefix_timestamp_randomId
      const pattern = /^[a-z0-9]{8}_[a-z0-9]+_[a-f0-9]{32}$/;
      expect(result.sessionId).toMatch(pattern);
    });
  });
});

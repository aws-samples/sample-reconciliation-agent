/**
 * Authentication utilities for extracting user info from a Microsoft Entra
 * ID JWT in the Authorization header.
 *
 * Note: this is NOT cryptographic verification — the gateway / runtime
 * authorizers verify signatures upstream. This module only extracts claims
 * for session-keying purposes after the token has already been validated.
 */

interface AuthUser {
  /** Stable Entra `oid` (object ID). */
  userId: string;
  email?: string;
  /** Display name from `preferred_username`. */
  username?: string;
}

/**
 * Extract user information from a JWT in the Authorization header.
 * Reads Entra v2 claims (oid, preferred_username, email).
 */
export function extractUserFromRequest(request: Request): AuthUser {
  try {
    // Get Authorization header
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { userId: "anonymous" };
    }

    // Extract JWT token
    const token = authHeader.substring(7);

    // Decode JWT payload (base64)
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.warn("[Auth] Invalid JWT format");
      return { userId: "anonymous" };
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8"),
    );

    // Entra: oid is the stable per-tenant object ID. preferred_username is
    // the user's UPN/email-shaped identifier. sub is per-app and changes
    // across apps in the same tenant — do NOT use it as the data key.
    const userId = payload.oid || payload.sub || "anonymous";
    const email = payload.email || payload.preferred_username;
    const username = payload.preferred_username || payload.name;

    console.log(
      `[Auth] Authenticated user: ${userId} (${email || username || "no email"})`,
    );

    return {
      userId,
      email,
      username,
    };
  } catch (error) {
    console.error("[Auth] Error extracting user from token:", error);
    return { userId: "anonymous" };
  }
}

/**
 * Generate or extract session ID from request headers
 * Session ID must be >= 33 characters to meet AgentCore Runtime validation
 */
export function getSessionId(
  request: Request,
  userId: string,
): { sessionId: string } {
  // Check for existing session ID in header
  const headerSessionId = request.headers.get("X-Session-ID");
  if (headerSessionId) {
    return { sessionId: headerSessionId };
  }

  // Generate new session ID >= 33 characters
  // Format: userPrefix_timestamp_randomUUID (approx 50+ chars)
  const timestamp = Date.now().toString(36); // ~10 chars
  const randomId = crypto.randomUUID().replace(/-/g, ""); // 32 hex chars
  const userPrefix =
    userId !== "anonymous" ? userId.substring(0, 8) : "anon0000"; // 8 chars

  const sessionId = `${userPrefix}_${timestamp}_${randomId}`;

  console.log(`[Auth] Generated session ID (length: ${sessionId.length})`);

  return { sessionId };
}

// Check if running in local development mode
const IS_LOCAL = process.env.NEXT_PUBLIC_AGENTCORE_LOCAL === "true";

interface SessionData {
  title: string;
  messageCount?: number;
  lastMessageAt?: string;
  status?: "active" | "archived" | "deleted";
  starred?: boolean;
  tags?: string[];
  metadata?: Record<string, any>;
}

/**
 * Ensure session exists in storage (DynamoDB or local file)
 * Creates session if it doesn't exist, returns isNew flag
 */
export async function ensureSessionExists(
  userId: string,
  sessionId: string,
  defaultData: SessionData,
): Promise<{ isNew: boolean }> {
  const now = new Date().toISOString();
  const sessionData = {
    ...defaultData,
    messageCount: defaultData.messageCount ?? 0,
    lastMessageAt: defaultData.lastMessageAt ?? now,
    status: defaultData.status ?? ("active" as const),
    starred: defaultData.starred ?? false,
    tags: defaultData.tags ?? [],
  };

  if (IS_LOCAL) {
    const { getSession, upsertSession } =
      await import("@/lib/local-session-store");
    const existingSession = getSession(userId, sessionId);
    if (!existingSession) {
      upsertSession(userId, sessionId, sessionData);
      console.log(`[Session] Created new local session: ${sessionId}`);
      return { isNew: true };
    }
    return { isNew: false };
  } else {
    const { getSession, upsertSession } = await import("@/lib/dynamodb-client");
    const existingSession = await getSession(userId, sessionId);
    if (!existingSession) {
      await upsertSession(userId, sessionId, sessionData);
      console.log(`[Session] Created new DynamoDB session: ${sessionId}`);
      return { isNew: true };
    }
    return { isNew: false };
  }
}

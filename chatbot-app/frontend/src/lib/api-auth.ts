/**
 * Server-side authorization for the reconciliation BFF (`/api/recon/*`).
 *
 * Live QA 2026-08-09 (P0-2) found the BFF completely open: the Okta wrapper gates the UI, but
 * the API routes underneath it read and WRITE with the ECS task role, so an anonymous caller
 * could PUT the agent system prompt or approve a case (ledger write + outbound email) just by
 * hitting the URL. This module is the verifier; `src/proxy.ts` is the choke point that
 * applies it to every route under `/api/recon/` before the handler runs.
 *
 * Kept separate from the middleware so it is unit-testable without booting a Next.js server.
 *
 * Deliberate design points:
 *  - The browser sends its **ID token**. For an Okta OIDC app the ID token's `aud` is exactly
 *    the client id and `iss` is the org's authorization server, so "was this minted for THIS app
 *    by THIS org" is a complete check. An ID token is formally a client artifact rather than an
 *    API credential; that is acceptable here only because the BFF is this SPA's own server tier
 *    on the same origin. The hardening step is a custom Okta authorization server issuing
 *    access tokens with a dedicated audience.
 *  - A missing/incoherent configuration resolves to `misconfigured`, which the middleware turns
 *    into a **503 — never an open door**. A deploy that loses its issuer env var must break
 *    visibly rather than silently reopen the API.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse } from "next/server";

/** How the BFF is configured to authorize callers. */
export type ApiAuthMode = "okta" | "entra" | "anonymous" | "misconfigured";

export interface ApiAuthConfig {
  mode: ApiAuthMode;
  /** Expected `iss` claim (verify modes only). */
  issuer?: string;
  /** Expected `aud` claim — the OIDC client id (verify modes only). */
  audience?: string;
  /** Absolute URL of the provider's JWKS document (verify modes only). */
  jwksUri?: string;
  /** Why the config is unusable — surfaced in the 503 body (misconfigured only). */
  reason?: string;
}

export type AuthResult =
  | { ok: true; mode: ApiAuthMode; subject: string; groups: string[] }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Read the caller's group memberships out of a verified token payload.
 *
 * Which claim carries them is a per-deployment fact, not a constant: Okta puts them in `groups` when
 * the app is configured to release them, Entra uses `groups` or `roles` depending on how the app
 * registration is set up, and an app that was never configured to release them at all sends none. So
 * the claim NAME comes from the environment and an absent claim yields an empty list — the caller is
 * simply in no groups, which every consumer must already handle.
 *
 * Read only from a payload `jwtVerify` has already returned, never from an unverified token: a group
 * list is an authorization input, and the whole point is that the caller could not have written it.
 *
 * @param payload the verified JWT payload.
 * @param env process environment to read `AUTH_GROUPS_CLAIM` from (injected in tests).
 * @returns the caller's groups, or `[]` when the claim is absent or not a list of strings.
 */
function groupsFrom(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const claim = env.AUTH_GROUPS_CLAIM || "groups";
  const raw = payload[claim];
  if (!Array.isArray(raw)) return [];
  return raw.filter((g): g is string => typeof g === "string");
}

/** Drop a trailing slash so `${issuer}/v1/keys` never doubles up. */
function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Derive an Okta JWKS URL from its issuer.
 *
 * Okta has two issuer shapes and they publish keys at different paths: a custom authorization
 * server (`https://<org>.okta.com/oauth2/default`) serves `<issuer>/v1/keys`, while the org
 * server (`https://<org>.okta.com`) serves `<issuer>/oauth2/v1/keys`. Guessing one breaks the
 * other, so branch on the `/oauth2/` segment.
 */
export function oktaJwksUri(issuer: string): string {
  const base = trimSlash(issuer);
  return base.includes("/oauth2/")
    ? `${base}/v1/keys`
    : `${base}/oauth2/v1/keys`;
}

/**
 * Resolve the authorization configuration from the environment.
 *
 * Pure (env is injectable) so the precedence rules are unit-testable. Note these are PLAIN env
 * vars, not `NEXT_PUBLIC_*`: the Dockerfile bakes `NEXT_PUBLIC_*` into the builder stage only,
 * so the running container cannot read them — the ECS task definition supplies `AUTH_PROVIDER`
 * / `OKTA_ISSUER` / `OKTA_CLIENT_ID` at runtime. The `NEXT_PUBLIC_*` fallbacks below exist only
 * for `next dev`, which loads `.env.local` into the server process.
 *
 * @param env process environment to read (injected in tests).
 * @returns the resolved config; `mode: "misconfigured"` when it cannot be trusted.
 */
export function resolveApiAuth(
  env: Record<string, string | undefined> = process.env,
): ApiAuthConfig {
  // Explicit local-dev escape hatch. Deliberately an exact "true" match on a
  // recon-specific name so it cannot be switched on by a generic NODE_ENV/CI variable.
  if (env.RECON_ALLOW_ANONYMOUS_API === "true") {
    return { mode: "anonymous" };
  }

  const provider = (
    env.AUTH_PROVIDER ??
    env.NEXT_PUBLIC_AUTH_PROVIDER ??
    ""
  ).toLowerCase();

  if (provider === "okta") {
    const issuer = trimSlash(
      env.OKTA_ISSUER ?? env.NEXT_PUBLIC_OKTA_ISSUER ?? "",
    );
    const audience = env.OKTA_CLIENT_ID ?? env.NEXT_PUBLIC_OKTA_CLIENT_ID ?? "";
    if (!issuer || !audience) {
      return {
        mode: "misconfigured",
        reason:
          "AUTH_PROVIDER=okta but OKTA_ISSUER and/or OKTA_CLIENT_ID are unset",
      };
    }
    return { mode: "okta", issuer, audience, jwksUri: oktaJwksUri(issuer) };
  }

  if (provider === "entra") {
    const tenantId =
      env.ENTRA_TENANT_ID ?? env.NEXT_PUBLIC_ENTRA_TENANT_ID ?? "";
    const audience =
      env.ENTRA_CLIENT_ID ?? env.NEXT_PUBLIC_ENTRA_CLIENT_ID ?? "";
    if (!tenantId || !audience) {
      return {
        mode: "misconfigured",
        reason:
          "AUTH_PROVIDER=entra but ENTRA_TENANT_ID and/or ENTRA_CLIENT_ID are unset",
      };
    }
    return {
      mode: "entra",
      // Entra v2 endpoints — v1 (`sts.windows.net`) tokens fail this issuer check by design.
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience,
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    };
  }

  return {
    mode: "misconfigured",
    reason: provider
      ? `unsupported AUTH_PROVIDER "${provider}" (expected "okta" or "entra")`
      : "AUTH_PROVIDER is unset — set it, or set RECON_ALLOW_ANONYMOUS_API=true for local dev",
  };
}

/**
 * Cached remote key sets, one per JWKS URL.
 *
 * `createRemoteJWKSet` does its own key caching and rate limiting, but only within the object it
 * returns — building a fresh one per request would refetch the JWKS on every API call and get
 * the task throttled by the provider.
 */
const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwkSets.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwkSets.set(jwksUri, set);
  }
  return set;
}

/**
 * Decide whether a thrown verification error is the caller's fault (401) or ours (503).
 *
 * jose tags its failures with a `code`. Token-shaped problems (expired, bad signature, wrong
 * audience, no matching key) are the caller's. Anything that means we could not TALK to the
 * provider — a JWKS fetch timeout, DNS failure, `fetch failed` — is an availability problem and
 * must not be reported as "your token is bad": in `private_vpc` mode the task has no internet
 * egress and every request would otherwise look like an auth failure.
 */
function statusForVerifyError(error: unknown): 401 | 503 {
  const code = (error as { code?: string })?.code ?? "";
  // Reaching the provider failed, or the provider's own key set is ambiguous — not the caller's
  // fault either way.
  if (
    code === "ERR_JWKS_TIMEOUT" ||
    code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS"
  ) {
    return 503;
  }
  // Every other jose error code (ERR_JWT_EXPIRED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED,
  // ERR_JOSE_ALG_NOT_ALLOWED, ERR_JWKS_NO_MATCHING_KEY, ...) describes a bad token. Matching the
  // family prefixes rather than "ERR_JW" is deliberate: ERR_JOSE_* would otherwise slip through
  // and an alg=none token would be reported as a server outage instead of a rejection.
  return /^ERR_(JWT|JWS|JWKS|JWK|JOSE)_/.test(code) ? 401 : 503;
}

/**
 * Authorize an inbound BFF request.
 *
 * @param request the incoming request (only its `authorization` header is read).
 * @param config resolved auth configuration (injected in tests).
 * @returns `{ ok: true }` with the verified subject, or `{ ok: false }` with the status the
 *   middleware should return. Never throws.
 */
export async function authorizeRequest(
  request: Request,
  config: ApiAuthConfig = resolveApiAuth(),
): Promise<AuthResult> {
  if (config.mode === "misconfigured") {
    return {
      ok: false,
      status: 503,
      message: `recon API authorization is not configured: ${config.reason}`,
    };
  }
  if (config.mode === "anonymous") {
    // `RECON_ALLOW_ANONYMOUS_API=true` already grants the whole BFF, so withholding the admin group
    // here would only make the Config tab untestable locally without pretending to secure anything.
    // The group is named from the environment so a local run and the deployment agree on the string.
    const admin = process.env.RECON_ADMIN_GROUP;
    return {
      ok: true,
      mode: "anonymous",
      subject: "anonymous",
      groups: admin ? [admin] : [],
    };
  }

  const header = request.headers.get("authorization") ?? "";
  // Scheme match is case-insensitive per RFC 6750; the token itself is not.
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return {
      ok: false,
      status: 401,
      message: "missing or malformed Authorization: Bearer <token> header",
    };
  }

  try {
    const { payload } = await jwtVerify(match[1], keySetFor(config.jwksUri!), {
      issuer: config.issuer,
      audience: config.audience,
      // Small tolerance for clock skew between the IdP and the Fargate task.
      clockTolerance: 60,
    });
    // `sub` is mandatory in an OIDC ID token; treat its absence as a rejected token rather
    // than inventing an identity for the audit trail.
    if (!payload.sub) {
      return { ok: false, status: 401, message: "token has no sub claim" };
    }
    return {
      ok: true,
      mode: config.mode,
      subject: payload.sub,
      groups: groupsFrom(payload),
    };
  } catch (error) {
    const status = statusForVerifyError(error);
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status,
      message:
        status === 401
          ? `token rejected: ${detail}`
          : `could not verify token (identity provider unreachable): ${detail}`,
    };
  }
}

/**
 * The authenticated principal for a write route, or the response explaining why there is none.
 *
 * `src/proxy.ts` has already rejected unauthenticated `/api/recon/*` by the time a handler runs, so
 * this rarely fails — it exists to NAME the actor on rows that record who changed them. Deriving that
 * name any other way (a header the client sets, a default like "operator") would produce an audit
 * trail that looks authoritative and is not, which is worse than having none.
 *
 * @param req - the incoming request.
 * @returns `{ actor }` on success, or `{ error }` holding the response to return unchanged.
 */
export async function requireActor(
  req: Request,
): Promise<{ actor: string } | { error: NextResponse }> {
  const auth = await authorizeRequest(req);
  if (!auth.ok)
    return {
      error: NextResponse.json(
        { error: auth.message },
        { status: auth.status },
      ),
    };
  return { actor: auth.subject };
}

/**
 * Server-side authorization for the shell's BFF: `/api/recon/*`, `/api/pipeline/*` and `/api/me`.
 *
 * Two applications share one Next.js server tier behind one app rail: Trade Reconciliation
 * (`/api/recon`) and Deal Pipeline (`/api/pipeline`). Both act with the ECS task role, so an
 * unauthenticated call to either one can read and WRITE production state. Live QA 2026-08-09 (P0-2)
 * found exactly that on the recon BFF: an anonymous caller could PUT the agent system prompt or
 * approve a case (ledger write + outbound email) just by hitting the URL. This module is the verifier
 * that closed it; `src/proxy.ts` is the choke point that applies it to every matched route before the
 * handler runs, and then layers per-app ACCESS on top (see `lib/auth/apps.ts`).
 *
 * The layers, from the outside in:
 *  1. Authentication (this module): who is calling, and which groups the identity provider vouched
 *     for. One token, one verification, shared by both apps, because the two apps are one OIDC client
 *     on one origin.
 *  2. App access (`lib/auth/apps.ts`, applied by the proxy): may this caller use THIS app at all.
 *  3. App administration (`lib/auth/app-admin.ts`, applied inside the write routes): may
 *     this caller change how the app behaves.
 *
 * Kept separate from the proxy so it is unit-testable without booting a Next.js server.
 *
 * Deliberate design points:
 *  - The browser sends its **ID token**. For an Okta OIDC app the ID token's `aud` is exactly
 *    the client id and `iss` is the org's authorization server, so "was this minted for THIS app
 *    by THIS org" is a complete check. An ID token is formally a client artifact rather than an
 *    API credential; that is acceptable here only because the BFF is this SPA's own server tier
 *    on the same origin. The hardening step is a custom Okta authorization server issuing
 *    access tokens with a dedicated audience.
 *  - A missing/incoherent configuration resolves to `misconfigured`, which the proxy turns into a
 *    **503 — never an open door**. A deploy that loses its issuer env var must break visibly rather
 *    than silently reopen the API.
 *  - Anonymous mode is ONE switch for both apps. `ALLOW_ANONYMOUS_API=true` is the name; the
 *    app-specific `RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API` are still honoured
 *    so a checkout or a dev deployment that predates the shell keeps working, but all three mean the
 *    same thing. There is one server process, so there is no way to leave one app open and the other
 *    verified; pretending otherwise with two switches would only invite the misconfiguration.
 *  - Anonymous mode grants every configured app group, so a local run sees every app as an admin
 *    (`ANONYMOUS_GROUPS` narrows that, which is how a developer previews what a restricted user
 *    sees). Withholding the groups would buy no safety: the switch has already opened the whole BFF.
 */

import { effectiveEnv } from "@/lib/console/settings";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse } from "next/server";

import { allConfiguredGroups } from "@/lib/auth/apps";

/** How the BFF is configured to authorize callers. */
export type ApiAuthMode = "okta" | "entra" | "anonymous" | "misconfigured";

/**
 * The modes a request can actually be authorized under. `misconfigured` never yields `ok: true`, and
 * saying so in the type is what lets `/api/me` hand the mode to the shell's `Viewer` without a cast.
 */
export type VerifiedAuthMode = Exclude<ApiAuthMode, "misconfigured">;

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
  | { ok: true; mode: VerifiedAuthMode; subject: string; groups: string[] }
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
export function groupsFrom(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const claim = env.AUTH_GROUPS_CLAIM || "groups";
  const raw = payload[claim];
  if (!Array.isArray(raw)) return [];
  return raw.filter((g): g is string => typeof g === "string");
}

/**
 * The variables that switch the BFF into anonymous mode, in the order they are documented.
 *
 * `ALLOW_ANONYMOUS_API` is the shell-era name. The other two are what each app used before it shared
 * a server with the other; they stay so `.env.local` files and dev task definitions written against
 * either app keep working unchanged. Each must be the exact string "true" — never a truthy check — so
 * a generic `NODE_ENV`/`CI` style variable cannot flip the API open by accident.
 */
const ANONYMOUS_SWITCHES = [
  "ALLOW_ANONYMOUS_API",
  "RECON_ALLOW_ANONYMOUS_API",
  "PIPELINE_ALLOW_ANONYMOUS_API",
] as const;

/**
 * Whether the environment asks for anonymous mode.
 *
 * @param env process environment to read (injected in tests).
 * @returns true when any of the three switches is exactly "true".
 */
export function isAnonymousEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return ANONYMOUS_SWITCHES.some((name) => env[name] === "true");
}

/**
 * The groups an anonymous caller is treated as belonging to.
 *
 * Default is every group the app registry knows about, so a local run without an identity provider
 * sees every app and every admin surface. `ANONYMOUS_GROUPS` (comma-separated, each name trimmed)
 * replaces that list when it names at least one group, which is how a developer previews the shell
 * as a restricted user: `ANONYMOUS_GROUPS=deal-desk` shows the pipeline as a plain user and hides a
 * restricted recon app. To preview a caller in NO groups, name one that no app is configured with
 * (`ANONYMOUS_GROUPS=nobody`); a blank value is read as "unset" because the codebase reads every
 * other empty group variable that way too.
 *
 * @param env process environment to read (injected in tests).
 * @returns the effective group list, de-duplicated.
 */
export function anonymousGroups(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const listed = (env.ANONYMOUS_GROUPS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return listed.length > 0 ? [...new Set(listed)] : allConfiguredGroups(env);
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
 * Precedence: the anonymous switch wins over a configured provider. A `.env.local` that names the
 * provider the BROWSER should use (`NEXT_PUBLIC_AUTH_PROVIDER`) while opening the server for local
 * work is the normal dev setup, not a conflict.
 *
 * @param env process environment to read (injected in tests).
 * @returns the resolved config; `mode: "misconfigured"` when it cannot be trusted.
 */
export function resolveApiAuth(
  env: Record<string, string | undefined> = process.env,
): ApiAuthConfig {
  if (isAnonymousEnabled(env)) {
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
      : "AUTH_PROVIDER is unset — set it, or set ALLOW_ANONYMOUS_API=true for local dev",
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
 * Authenticate an inbound BFF request.
 *
 * Authentication only: the result says who is calling and which groups they hold. Whether those
 * groups admit them to the app the path belongs to is the proxy's decision (`lib/auth/access.ts`),
 * and whether they may administer it is each write route's (`lib/auth/app-admin.ts`).
 *
 * @param request the incoming request (only its `authorization` header is read).
 * @param config resolved auth configuration (injected in tests).
 * @returns `{ ok: true }` with the verified subject and groups, or `{ ok: false }` with the status
 *   the proxy should return. Never throws.
 */
export async function authorizeRequest(
  request: Request,
  config: ApiAuthConfig = resolveApiAuth(),
): Promise<AuthResult> {
  if (config.mode === "misconfigured") {
    return {
      ok: false,
      status: 503,
      message: `API authorization is not configured: ${config.reason}`,
    };
  }
  if (config.mode === "anonymous") {
    // Groups are named from the environment overlaid with the console's stored settings, so a group
    // renamed on the Settings screen is still held by the local anonymous identity; see
    // `anonymousGroups` for why the default is "everything" and how to narrow it.
    return {
      ok: true,
      mode: "anonymous",
      subject: "anonymous",
      groups: anonymousGroups(await effectiveEnv()),
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
 * `src/proxy.ts` has already rejected unauthenticated and un-admitted `/api/recon/*` and
 * `/api/pipeline/*` calls by the time a handler runs, so this rarely fails — it exists to NAME the
 * actor on rows that record who changed them. Deriving that name any other way (a header the client
 * sets, a default like "operator") would produce an audit trail that looks authoritative and is not,
 * which is worse than having none.
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

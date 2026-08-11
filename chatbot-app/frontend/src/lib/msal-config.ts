/**
 * MSAL configuration for Microsoft Entra ID inbound auth.
 *
 * Active when NEXT_PUBLIC_AUTH_PROVIDER === 'entra'. See
 * the Entra-only auth design record for the migration design, and the Entra
 * app-registration setup guide (both kept outside this repository).
 *
 * The three NEXT_PUBLIC_ENTRA_* env vars are populated at build time by
 * infra/modules/chat (Docker build args sourced from auth-entra SSM params).
 */

import type { Configuration } from "@azure/msal-browser";

const tenantId = process.env.NEXT_PUBLIC_ENTRA_TENANT_ID || "";
const clientId = process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID || "";
const apiAudience = process.env.NEXT_PUBLIC_ENTRA_API_AUDIENCE || "";

export const HAS_ENTRA_CONFIG = !!(tenantId && clientId && apiAudience);

/**
 * Scope used for tool-call requests. The OBO exchange at AgentCore Gateway
 * requires this exact scope to be present in the inbound JWT's `scp` claim.
 *
 * Format: <api-audience>/<scope-name> per Microsoft's API permission model.
 * Example: api://11111111-1111-1111-1111-111111111111/access_as_user
 */
export const ENTRA_OBO_SCOPE = apiAudience
  ? `${apiAudience}/access_as_user`
  : "";

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: tenantId ? `https://login.microsoftonline.com/${tenantId}` : "",
    redirectUri: typeof window !== "undefined" ? window.location.origin : "",
    postLogoutRedirectUri:
      typeof window !== "undefined" ? window.location.origin : "",
  },
  cache: {
    cacheLocation: "localStorage",
  },
};

/**
 * Token request used by api-client-entra. Asks for the OBO scope so the
 * resulting access token's `scp` claim includes `access_as_user` and the
 * gateway authorizer (which enforces allowed_scopes=["access_as_user"])
 * accepts it.
 */
export const tokenRequest = {
  scopes: [ENTRA_OBO_SCOPE],
};

// Cognito OAuth 2.0 (authorization-code + PKCE) for the SPA. Unauthenticated users are sent
// to the Hosted UI; the callback exchanges the code for tokens. Config is injected at build
// time via Vite env (VITE_COGNITO_*), populated from the foundation/frontend Terraform outputs.

interface AuthConfig {
  hostedUiDomain: string; // e.g. recon-dev-login.auth.us-east-1.amazoncognito.com
  clientId: string;
  redirectUri: string; // CloudFront domain + /callback
  region: string;
}

function config(): AuthConfig {
  // Next.js inlines NEXT_PUBLIC_* at build time (set via Docker build args in the ECS image).
  // The redirect URI defaults to the current origin's /callback so it works behind CloudFront
  // without the CloudFront domain being known at build time (resolves the build/deploy cycle).
  const originRedirect =
    typeof window !== "undefined" ? `${window.location.origin}/callback` : "";
  return {
    hostedUiDomain: process.env.NEXT_PUBLIC_COGNITO_HOSTED_UI ?? "",
    clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "",
    redirectUri: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI || originRedirect,
    region: process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1",
  };
}

const VERIFIER_KEY = "recon.pkce_verifier";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(random);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

// Build the Hosted UI authorize URL (code flow + PKCE) and stash the verifier for the callback.
export async function buildLoginUrl(): Promise<string> {
  const { hostedUiDomain, clientId, redirectUri } = config();
  const { verifier, challenge } = await pkce();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://${hostedUiDomain}/oauth2/authorize?${params.toString()}`;
}

// Exchange an authorization code for tokens at the Hosted UI token endpoint.
export async function exchangeCode(
  code: string,
): Promise<{ access_token: string; id_token: string }> {
  const { hostedUiDomain, clientId, redirectUri } = config();
  const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const resp = await fetch(`https://${hostedUiDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`token exchange failed: ${resp.status}`);
  }
  return resp.json();
}

// Redirect to the Hosted UI logout endpoint.
export function logout(): void {
  const { hostedUiDomain, clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    logout_uri: redirectUri,
  });
  window.location.href = `https://${hostedUiDomain}/logout?${params.toString()}`;
}

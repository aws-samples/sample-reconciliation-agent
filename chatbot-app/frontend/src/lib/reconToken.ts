// Access-token accessor for recon BFF calls. Reads the Cognito access token stored by the
// OAuth callback (auth.ts exchangeCode). Kept separate from the sample's Entra/MSAL path so the
// recon surfaces authenticate against the platform's Cognito user pool.

const TOKEN_KEY = "recon.access_token";

export function storeAccessToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function getStoredAccessToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

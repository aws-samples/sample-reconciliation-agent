"use client";

import CognitoAuthWrapper, {
  cognitoSignOut,
} from "@/components/CognitoAuthWrapper";
import EntraAuthWrapper, { entraSignOut } from "@/components/EntraAuthWrapper";
import OktaAuthWrapper, { oktaSignOut } from "@/components/OktaAuthWrapper";
import { authProviderBranch } from "@/lib/auth/provider";

/**
 * Inbound auth gate. Selects the identity provider via NEXT_PUBLIC_AUTH_PROVIDER:
 *   - "cognito" → Amazon Cognito user pool, hosted UI + PKCE (DEFAULT when the variable is unset);
 *   - "okta"    → Okta OIDC;
 *   - "entra"   → Microsoft Entra ID.
 * Each wrapper handles its own client-hydration / local-dev / unconfigured pass-through.
 *
 * Cognito is the default because this is a sample deployed into a customer's own account: Okta and
 * Entra both need an external IdP tenant, which makes the app unrunnable on first deploy, while the
 * user pool is created by the same Terraform. An enterprise IdP is added later by federating it INTO
 * the pool, not by changing this variable. The default itself lives in `lib/auth/provider.ts`, which
 * is also what the token reader, the re-auth redirect and the header chip read — and the server-side
 * `resolveApiAuth` mirrors it, so the browser and the BFF cannot disagree about who is signing in.
 */
export default function AuthWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  switch (authProviderBranch()) {
    case "okta":
      return <OktaAuthWrapper>{children}</OktaAuthWrapper>;
    case "entra":
      return <EntraAuthWrapper>{children}</EntraAuthWrapper>;
    default:
      return <CognitoAuthWrapper>{children}</CognitoAuthWrapper>;
  }
}

/**
 * Sign out helper. Routes through the active provider's logout redirect.
 */
export async function signOut(): Promise<void> {
  switch (authProviderBranch()) {
    case "okta":
      await oktaSignOut();
      return;
    case "entra":
      await entraSignOut();
      return;
    default:
      await cognitoSignOut();
  }
}

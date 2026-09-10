"use client";

import EntraAuthWrapper, { entraSignOut } from "@/components/EntraAuthWrapper";
import OktaAuthWrapper, { oktaSignOut } from "@/components/OktaAuthWrapper";

const PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "entra";

/**
 * Inbound auth gate. Selects the identity provider via NEXT_PUBLIC_AUTH_PROVIDER:
 *   - "okta"  → Okta OIDC (replaces Entra when configured);
 *   - "entra" → Microsoft Entra ID (default).
 * Each wrapper handles its own client-hydration / local-dev / unconfigured pass-through.
 */
export default function AuthWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  if (PROVIDER === "okta") {
    return <OktaAuthWrapper>{children}</OktaAuthWrapper>;
  }
  return <EntraAuthWrapper>{children}</EntraAuthWrapper>;
}

/**
 * Sign out helper. Routes through the active provider's logout redirect.
 */
export async function signOut(): Promise<void> {
  if (PROVIDER === "okta") {
    await oktaSignOut();
    return;
  }
  await entraSignOut();
}

"use client";

import { useEffect, useState } from "react";
import { PublicClientApplication, EventType } from "@azure/msal-browser";
import { MsalProvider, useMsal } from "@azure/msal-react";
import { msalConfig, HAS_ENTRA_CONFIG, tokenRequest } from "@/lib/msal-config";

/**
 * Singleton MSAL instance. Created once per page load. The MsalProvider
 * children read tokens from this instance via the useMsal hook. Stashed on
 * window so api-client.ts shares the same instance instead of constructing
 * a second one (MSAL caches via localStorage either way, but sharing avoids
 * duplicate redirect-handling and event listener registration).
 */
function getMsalInstance(): PublicClientApplication {
  if (typeof window === "undefined") {
    return new PublicClientApplication(msalConfig);
  }
  const w = window as unknown as {
    __msal_instance?: PublicClientApplication;
  };
  if (!w.__msal_instance) {
    w.__msal_instance = new PublicClientApplication(msalConfig);
  }
  return w.__msal_instance;
}

/**
 * Inner gate that runs sign-in when no account is cached.
 * Mirrors AuthWrapper's behavior — show loading, then redirect to Microsoft
 * for sign-in if needed, then render children.
 */
/**
 * The waiting screen. Shared by the pre-hydration branch and the signing-in branch so both render
 * identical markup — see the `!isClient` branch below for why that matters.
 */
function SigningIn() {
  return (
    <div className="min-h-screen flex items-center justify-center gradient-subtle">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
        <span className="text-sm text-muted-foreground tracking-wide">
          Signing in with Microsoft...
        </span>
      </div>
    </div>
  );
}

function EntraAuthGate({ children }: { children: React.ReactNode }) {
  const { instance, accounts, inProgress } = useMsal();
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    // First mount: complete any redirect-flow response that's already in the URL
    instance
      .handleRedirectPromise()
      .then((response) => {
        if (response?.account) {
          instance.setActiveAccount(response.account);
        } else if (accounts.length > 0) {
          instance.setActiveAccount(accounts[0]);
        }
        setBootstrapped(true);
      })
      .catch((err) => {
        console.error("[Entra] Redirect handling failed:", err);
        setBootstrapped(true);
      });
  }, [instance, accounts]);

  // After bootstrap: if no account, kick off interactive login
  useEffect(() => {
    if (!bootstrapped) return;
    if (accounts.length === 0 && inProgress === "none") {
      instance.loginRedirect(tokenRequest).catch((err) => {
        console.error("[Entra] loginRedirect failed:", err);
      });
    }
  }, [bootstrapped, accounts.length, inProgress, instance]);

  if (!bootstrapped || accounts.length === 0) {
    return <SigningIn />;
  }

  return <>{children}</>;
}

/**
 * Public wrapper used in app/layout.tsx when NEXT_PUBLIC_AUTH_PROVIDER === 'entra'.
 * Renders children directly when running locally (no Entra config) or in iframe
 * scenarios where auth is handled elsewhere.
 */
export default function EntraAuthWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isClient, setIsClient] = useState(false);
  const [isLocalDev, setIsLocalDev] = useState(false);

  useEffect(() => {
    setIsClient(true);
    setIsLocalDev(
      window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1",
    );
  }, []);

  // Pre-hydration renders the waiting screen, NOT the children. Rendering children here mounted
  // the protected app before auth was known, so their effects fired API calls with whatever stale
  // token was in storage — and showed a signed-out user a flash of the real UI. Same defect the
  // Okta wrapper had; fixed the same way. Server and first client render agree: both <SigningIn />.
  if (!isClient) {
    return <SigningIn />;
  }

  // Skip auth in local dev, or when build-time env vars weren't populated.
  if (isLocalDev || !HAS_ENTRA_CONFIG) {
    return <>{children}</>;
  }

  const instance = getMsalInstance();

  return (
    <MsalProvider instance={instance}>
      <EntraAuthGate>{children}</EntraAuthGate>
    </MsalProvider>
  );
}

/**
 * Sign out helper. Call from menu / header components. Mirrors AuthWrapper's
 * `signOut` re-export for parity.
 */
export async function entraSignOut(): Promise<void> {
  const instance = getMsalInstance();
  const account = instance.getActiveAccount();
  await instance.logoutRedirect({
    account: account ?? undefined,
    postLogoutRedirectUri:
      typeof window !== "undefined" ? window.location.origin : undefined,
  });
}

// Re-export the EventType so consumers can listen if needed (parity with Hub).
export { EventType as MsalEventType };

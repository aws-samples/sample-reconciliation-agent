"use client";

import { useEffect, useState } from "react";
import { signOut } from "@/components/AuthWrapper";
import { cognitoUserName } from "@/components/CognitoAuthWrapper";
import { oktaUserName } from "@/components/OktaAuthWrapper";
import { authProviderBranch } from "@/lib/auth/provider";

/**
 * Top-right identity chip for an app's header: shows the logged-in user's name and a logout
 * control. Reads the name from the active auth provider — Cognito (ID-token claims), Okta (getUser)
 * or Entra (MSAL active account) — and falls back to "local" in dev / when auth is unconfigured.
 */
async function resolveName(): Promise<string> {
  try {
    switch (authProviderBranch()) {
      case "okta":
        return (await oktaUserName()) ?? "local";
      case "entra": {
        // Read the MSAL active account stashed on window by EntraAuthWrapper.
        const w = window as unknown as {
          __msal_instance?: {
            getActiveAccount?: () => { name?: string; username?: string } | null;
          };
        };
        const acct = w.__msal_instance?.getActiveAccount?.();
        return acct?.name || acct?.username || "local";
      }
      default:
        return (await cognitoUserName()) ?? "local";
    }
  } catch {
    return "local";
  }
}

export function UserMenu() {
  // The name comes from the provider, as it always has. Should the menu ever want the server's view
  // of the viewer (an admin marker, say), `useAppSubject` reads the shell's already-loaded viewer
  // store at no extra request — there is nothing to prefetch here.
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    resolveName().then(setName);
  }, []);

  return (
    <div className="rc-mono ml-auto flex items-center gap-3 text-[11px] text-[var(--rc-ink-faint)]">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: "var(--rc-green)",
          boxShadow: "0 0 6px var(--rc-green)",
        }}
      />
      <span className="text-[var(--rc-ink)]" title="Signed-in user">
        {name ?? "…"}
      </span>
      <button
        onClick={() => signOut()}
        className="rounded border border-[var(--rc-line)] px-2 py-1 uppercase tracking-[0.1em] hover:text-[var(--rc-ink)]"
        title="Sign out"
      >
        Logout
      </button>
    </div>
  );
}

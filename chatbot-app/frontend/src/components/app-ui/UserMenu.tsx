"use client";

import { useEffect, useState } from "react";
import { signOut } from "@/components/AuthWrapper";
import { oktaUserName } from "@/components/OktaAuthWrapper";
import { useAppSubject } from "@/hooks/useAppSubject";
import type { AppId } from "@/lib/auth/apps";

const PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "entra";

/**
 * Top-right identity chip for an app's header: shows the logged-in user's name and a logout
 * control. Reads the name from the active auth provider — Okta (getUser) or Entra (MSAL active
 * account) — and falls back to "local" in dev / when auth is unconfigured.
 */
async function resolveName(): Promise<string> {
  try {
    if (PROVIDER === "okta") {
      return (await oktaUserName()) ?? "local";
    }
    // Entra: read the MSAL active account stashed on window by EntraAuthWrapper.
    const w = window as unknown as {
      __msal_instance?: {
        getActiveAccount?: () => { name?: string; username?: string } | null;
      };
    };
    const acct = w.__msal_instance?.getActiveAccount?.();
    return acct?.name || acct?.username || "local";
  } catch {
    return "local";
  }
}

export function UserMenu({ appId }: { appId: AppId }) {
  const [name, setName] = useState<string | null>(null);
  // The viewer as the server sees them. Nothing from it is rendered yet — the name shown comes from
  // the provider, as it always has — but the header's two identity consumers (this and `AppNav`)
  // resolve it through the same cached request, so the menu can grow an admin marker later without a
  // new data path or a second fetch.
  useAppSubject(appId);

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

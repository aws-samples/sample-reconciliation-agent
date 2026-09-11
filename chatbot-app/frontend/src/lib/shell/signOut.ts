"use client";

import { useCallback, useState } from "react";

import { signOut } from "@/components/AuthWrapper";

// Sign-out for the shell's two controls (the rail footer and the landing page's cards).
//
// The provider SDKs reject rather than redirect when they have nothing to sign out of — MSAL with an
// unconfigured client id, OktaAuth with an empty issuer — and a `void signOut()` discards that
// rejection, leaving a button that does nothing. Callers should not render the control at all when
// the viewer is anonymous (see `viewer.mode`); this hook is for everything else that can still go
// wrong, so the user reads why instead of clicking again.

/** What the user sees when the provider refused to sign them out. */
export const SIGN_OUT_FAILED_MESSAGE = "Sign out failed. Reload the page and try again.";

export interface SignOutControl {
  /** Start the provider's sign-out redirect. Safe to call from an event handler; never throws. */
  signOut: () => void;
  /** Why the last attempt failed, for display next to the control; `null` until one fails. */
  error: string | null;
}

/**
 * Sign out with the failure surfaced rather than swallowed.
 *
 * @returns the trigger and the last failure message.
 */
export function useSignOut(): SignOutControl {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => {
    setError(null);
    void (async () => {
      try {
        await signOut();
      } catch (err) {
        // The full error goes to the console for the operator; the user gets a sentence they can act on.
        console.error("[Shell] sign out failed:", err);
        setError(SIGN_OUT_FAILED_MESSAGE);
      }
    })();
  }, []);
  return { signOut: run, error };
}

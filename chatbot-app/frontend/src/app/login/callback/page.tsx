"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Okta OIDC sign-in redirect target (`oktaRedirectUri()` = `${origin}/login/callback`, the URI
 * registered in the Okta app). Without this route Next.js 404s the redirect and the user is
 * stranded after login.
 *
 * The token exchange itself is done by OktaAuthWrapper (mounted in the root layout): it detects
 * `isLoginRedirect()`, calls `handleLoginRedirect()`, and only renders its children once the
 * session is established — so by the time THIS page mounts, auth is complete and the URL has been
 * cleaned. All this component does is forward the now-authenticated user to the app landing
 * (`/` is the console landing: it opens the only accessible app or shows the chooser).
 */
export default function LoginCallback() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="text-sm text-muted-foreground tracking-wide">
        Completing sign-in…
      </span>
    </div>
  );
}

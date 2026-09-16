"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { consumeReturnTo } from "@/lib/auth/cognito-pkce";

/**
 * Cognito hosted UI redirect target (`cognitoRedirectUri()` = `${origin}/callback`, the URL listed on
 * the app client). Without this route Next.js 404s the redirect and the user is stranded after login.
 *
 * The code-for-token exchange itself is done by CognitoAuthWrapper (mounted in the root layout): it
 * sees `?code=` in the URL, verifies `state`, exchanges, and only renders its children once there is
 * a session — so by the time THIS page mounts, auth is complete, and a refusal from the hosted UI
 * (`?error=`) has already been shown by the wrapper instead of this page. Same division of labour as
 * `/login/callback` for Okta, where the SDK does the exchange inside the wrapper.
 *
 * All this page does is forward the now-authenticated user to where they were going: the path
 * recorded when the redirect started, or `/` (the console landing, which opens the only accessible
 * app or shows the chooser). `consumeReturnTo()` guarantees a same-origin path.
 */
export default function CognitoCallback() {
  const router = useRouter();
  useEffect(() => {
    router.replace(consumeReturnTo());
  }, [router]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="text-sm text-muted-foreground tracking-wide">
        Completing sign-in…
      </span>
    </div>
  );
}

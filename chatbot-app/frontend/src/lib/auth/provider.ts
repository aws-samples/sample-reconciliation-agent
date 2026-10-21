/**
 * Which identity provider the BROWSER signs in with. One reader, so nothing can disagree.
 *
 * Four modules used to carry their own `process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "entra"`: the auth
 * gate (`components/AuthWrapper.tsx`), the token reader (`lib/auth/client-token.ts`), the
 * re-authentication redirect (`lib/reauth.ts`) and the header's identity chip
 * (`components/app-ui/UserMenu.tsx`). Four copies of a default is one copy too many the moment the
 * default changes: a build where the gate signs in with Cognito while the token reader looks for an
 * MSAL account renders the app and then 401s every call, with nothing on screen to say why.
 *
 * The DEFAULT is Cognito (decided 2026-09-16). Rationale, since this reverses the previous default:
 * this repo is a public AWS sample that customers deploy in their own accounts, and Okta/Entra both
 * require an external IdP tenant nobody has on first run — so the sample was unrunnable as shipped.
 * Amazon Cognito is a resource the same Terraform can create, Well-Architected SEC02-BP04 names it
 * for "users of your applications", and an enterprise IdP is plugged in later by federating SAML/OIDC
 * INTO the pool rather than by changing this variable. Okta and Entra remain fully supported and are
 * selected exactly as before.
 *
 * Resolution rules, and why they are shaped this way:
 *  - UNSET or blank → Cognito. Blank counts as unset because a container build arg declared with no
 *    value renders as "", and the codebase reads every other blank variable that way too.
 *  - the exact strings "okta" / "entra" / "cognito" → that provider.
 *  - anything else → Entra, which is what an unrecognised value resolved to before Cognito existed.
 *    Deliberately NOT lower-cased and NOT trimmed: `"Okta"` picked Entra yesterday and must pick
 *    Entra today. Changing the meaning of a value someone already has set is a different decision
 *    from changing the meaning of not setting one, and only the second was asked for.
 *
 * Read at module load, like every `NEXT_PUBLIC_*` value: Next.js inlines these at BUILD time, and it
 * can only do so for a literal `process.env.NEXT_PUBLIC_X` member expression. A helper that took an
 * env object as a parameter would read `undefined` in the browser bundle no matter what the task
 * definition says — which is exactly the bug the server-side `resolveApiAuth` comment warns about
 * from the other direction. Tests re-import with `vi.resetModules()` after setting the variable.
 */

/** The providers the browser can sign in with. */
export type AuthProviderId = "cognito" | "okta" | "entra";

/** What an unset `NEXT_PUBLIC_AUTH_PROVIDER` means. Mirrored server-side by `resolveApiAuth`. */
export const DEFAULT_AUTH_PROVIDER: AuthProviderId = "cognito";

const configured = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

/**
 * The value of `NEXT_PUBLIC_AUTH_PROVIDER`, or the default when it is unset or blank.
 *
 * Exported raw (not narrowed) so error messages can quote what the deployment actually asked for.
 */
export const AUTH_PROVIDER: string =
  configured === undefined || configured === ""
    ? DEFAULT_AUTH_PROVIDER
    : configured;

/**
 * The provider branch every consumer must take.
 *
 * One function rather than a comparison at each call site: the Entra fallback for an unrecognised
 * value is a compatibility rule, and a rule stated four times is a rule that will eventually be
 * stated three ways.
 *
 * @returns the provider whose sign-in, token reader and sign-out this build uses.
 */
export function authProviderBranch(): AuthProviderId {
  if (AUTH_PROVIDER === "okta") return "okta";
  if (AUTH_PROVIDER === "cognito") return "cognito";
  return "entra";
}

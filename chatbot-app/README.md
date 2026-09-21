# `chatbot-app/` — the operator console

A Next.js app that is both the UI and its own backend-for-frontend, hosting two applications behind
one shell: Trade Reconciliation (`/recon`, BFF `/api/recon`) and Deal Pipeline (`/pipeline`, BFF
`/api/pipeline`). `/` is the landing chooser and a collapsible app rail switches between the apps the
viewer may open. It runs as one Fargate task behind an ALB and CloudFront (`infra/modules/frontend-ecs`),
or locally with `npm run dev`.

```
frontend/src/app/page.tsx         the landing chooser; /api/me reports the viewer's per-app access
frontend/src/lib/auth/apps.ts     the app registry: paths, BFF prefixes, access + admin group names
frontend/src/lib/auth/            the rest of the identity spine both apps and the shell share:
                                  provider.ts (the ONE reader of NEXT_PUBLIC_AUTH_PROVIDER and the only
                                  place its default lives), cognito-pkce.ts (the default provider's whole
                                  browser flow, no SDK), client-token.ts (the browser's ID-token reader),
                                  authed-fetch.ts (the one 401-aware fetch every BFF client is built on),
                                  app-admin.ts (the admin gate every admin-only write route calls,
                                  parameterised by app)
frontend/src/components/          the three auth gates AuthWrapper.tsx switches between:
                                  CognitoAuthWrapper (default), OktaAuthWrapper, EntraAuthWrapper
frontend/src/app/callback/        the Cognito hosted-UI redirect target; /login/callback is Okta's
frontend/src/lib/shell/viewer.ts  the one /api/me read: the viewer store the rail, the landing page and
                                  every app page derive the signed-in viewer from
frontend/src/lib/console/        the console-wide settings layer: types.ts (the contract: SSM layout,
                                  resolution order, /api/console/* shapes), settings.ts (the SSM
                                  overlay + 30 s cache), validation, admin gate
frontend/src/app/console/settings the Settings screen; frontend/src/components/console/ its tabs
frontend/src/app/api/console/     settings, access-check, preferences routes
frontend/src/proxy.ts             the gate in front of both BFFs
frontend/src/app/app-theme.css    the shared "instrument" theme every app renders under (.app-root,
                                  rc-* classes, --rc-* tokens)
frontend/src/components/app-ui/   chrome and primitives shared by the apps: AppChrome (header, AppNav,
                                  UserMenu), DataTable, ui.tsx (Panel, Pill, Modal, Notice, buttons),
                                  ModelSelectPanel (the model row both Config tabs mount),
                                  MemoryPanel (records, strategy card and confirmed delete over an app's
                                  memory routes; recon's Lessons tab and the pipeline's Memory Manager
                                  mount it), SkillsCatalog + SkillEditor + PromptEditorPage (the skills
                                  catalogue, one-skill editor and system-prompt page both Skills tabs
                                  mount; recon edits in place on the catalogue, the pipeline on its
                                  skills/[name] route)
frontend/src/lib/server/          helpers both BFFs share: http (the error envelope), ssm (readParam /
                                  writeParam: the Parameter Store read and write behind both Config
                                  routes and recon's prompt and eval helpers), agentModels (the model
                                  allowlist), memoryRequests,
                                  memoryClient (createMemoryClient: the one AgentCore Memory client;
                                  recon binds RECON_MEMORY_ID in lib/reconMemory.ts, the pipeline its
                                  two ids in lib/pipeline/server/memoryClient.ts),
                                  skillsStore (createSkillsStore: the one S3 skills + system-prompt
                                  store, parameterised by bucket, prefix, prompt key and five options
                                  whose defaults are recon's behaviour; recon binds ASSETS_BUCKET /
                                  SKILLS_PREFIX / SYSTEM_PROMPT_KEY in lib/reconSkills.ts, the pipeline
                                  its PIPELINE_ names in lib/pipeline/server/skillsStore.ts)
frontend/src/hooks/useAppSubject.ts
                                  the viewer for one app (subject, groups, isAdmin), projected from the
                                  viewer store; useReconSubject.ts is its recon-named binding

frontend/src/app/recon/           screens: dashboard, queue, case/[id], skills, lessons, evals,
                                  idp-documents, config
frontend/src/app/api/recon/       the recon BFF — every AWS call the browser cannot make itself
frontend/src/components/recon/    the recon app's own components
frontend/src/lib/                 recon clients, stores and policy helpers (recon*, api-auth, ...)

frontend/src/app/pipeline/        screens: inbox, inbox/[id], deals, deals/[id], assistant,
                                  skills, skills/[name], skills/system-prompt, skills/proposals, config
frontend/src/app/api/pipeline/    the pipeline BFF (emails, deals, chat SSE, memory, skills, config)
frontend/src/components/pipeline/ the pipeline app's own components
frontend/src/lib/pipeline/        wire types, the OMS schema mirror, and server/ (env, aws, stores,
                                  samples, the chat agent)

frontend/__tests__/               vitest, mirroring the trees above; helpers/ holds the shared
                                  test doubles (AWS SDK mocks, in-memory DynamoDB/S3/SSM, env scope)
```

```bash
cd frontend
npx vitest run          # the suite
npx tsc --noEmit        # typecheck
npx prettier --check .  # formatting
```

Repo-wide ESLint is broken; `prettier` + `tsc` are the local gate and CI's `frontend` job is the real
one.

## Two apps, one shell

The apps do not import each other. What they share is the auth module (`src/lib/auth/`,
`src/lib/api-auth.ts`, `src/lib/reauth.ts`), the console's instrument theme (`src/app/app-theme.css`)
and the chrome and primitives built on it (`src/components/app-ui/`: the header with its nav and user
menu, the column-preferences table, the panel/pill/modal primitives, the model-selection row both
Config tabs mount, the skills catalogue, editor and prompt page both Skills tabs mount), the
`src/components/ui/` primitives and the server helpers in `src/lib/server/` (the error envelope, the
Parameter Store read/write behind both Config routes, the model allowlist, the S3 skills store behind
both Skills tabs);
each keeps its own nav links, status vocabulary, hooks and BFF. Who may open which app comes
from identity-provider groups — `RECON_ACCESS_GROUP` / `RECON_ADMIN_GROUP` and `PIPELINE_ACCESS_GROUP`
/ `PIPELINE_ADMIN_GROUP`, resolved by `src/lib/auth/apps.ts`. An unset access group leaves that app
open to every authenticated user, unless `REQUIRE_ACCESS_GROUPS=true`, which the composed deployment
sets whenever the pipeline is enabled: then a blank access group denies the app to everyone but its
admins. An unset admin group means nobody can change it. (Under the default Cognito provider the
console never sees a blank one: the recon root resolves each name to the group the user pool actually
created — see [Sign-in](#sign-in) — so "unset access = open" is an Okta/Entra situation only.) `PIPELINE_ENABLED=false` switches the
pipeline app off entirely (hidden from `/api/me`, 403 from the proxy); unset means enabled. Locally,
`ALLOW_ANONYMOUS_API=true` grants everything and `ANONYMOUS_GROUPS` previews a restricted user — the
pre-shell names `RECON_ALLOW_ANONYMOUS_API` and `PIPELINE_ALLOW_ANONYMOUS_API` still mean the same
thing, and none of the three belongs in a deployment. `frontend/.env.example` is the template for
both apps.

Identity is read once. `/api/me` is the only "who am I" route — there is no `/api/recon/me` or
`/api/pipeline/me` — and `src/lib/shell/viewer.ts` asks it once per page load for the rail, the landing
page and every app page alike. An app page derives its viewer from that one read through
`useAppSubject("recon" | "pipeline")` (`useReconSubject` is the recon-named binding): the subject keys
stored column layouts and `isAdmin`, read from the body's per-app block, hides admin-only tabs. Both
are advisory; the routes decide. Every BFF client (`reconApi`, `pipelineApi`, `consoleApi`) sends
through `src/lib/auth/authed-fetch.ts`, which attaches the token and turns a 401 into the shared
re-authentication, and every admin-only write route re-checks the group through
`src/lib/auth/app-admin.ts` (`requireAppAdmin`, or `requireAppActor` where a route is open to all but
behaves differently for admins; `reconAdmin.ts` keeps the recon-named entry points).

Admin gating differs between the apps, and it matters for what an access group buys. Every pipeline
write route re-checks `PIPELINE_ADMIN_GROUP`. On the recon side only `config/*`, `memory` DELETE and
`uploads` do; `system-prompt`, `skills`, `harness/configs`, `evals/batch` and bulk `cases` writes are
open to anyone the proxy admits, so `RECON_ACCESS_GROUP` is the real boundary on the recon agent's
behaviour. Both Skills tabs read and write through the one shared store (`src/lib/server/skillsStore.ts`)
with per-app options, and the recon skills and system-prompt routes staying ungated is a recorded
decision (`docs/shared-spine-proposal.md` §8a, option 1), not something the sharing left behind.

The shell also has a **Settings** screen (`/console/settings`, from the Settings entry in the rail's
footer) for what belongs to the console rather than to one app, in five `?tab=` sections: **Access**
(each app's access and admin group), **Applications** (whether the Deal Pipeline is switched on),
**Defaults** (a model id an app may copy, and the organization label under the console mark in the
rail), **Users** (who the console takes you for, plus a check-access tool for admins) and
**Preferences** (your own default app, rail state and theme). Its contract is
`src/lib/console/types.ts`. Values are stored one SSM parameter each under `CONSOLE_SETTINGS_PREFIX`
and _overlay_ the environment names above — stored → env → default, with a `stored` / `env` /
`default` chip beside every field — so `apps.ts`, the proxy and the admin helpers read them through
`effectiveEnv()` unchanged; each process caches the layer for 30 s, so an edit reaches the proxy and
every other task within that window (and resolves from the environment alone for one window when
Parameter Store cannot be read). Editing needs membership of `CONSOLE_ADMIN_GROUP`, which, like
`REQUIRE_ACCESS_GROUPS` and the anonymous switch, is environment-only and cannot be changed from the
screen, so no UI edit can widen access past the deployment or make someone a console admin; unset
means nobody, and the three admin sections show their structure without values. With
`CONSOLE_SETTINGS_PREFIX` unset the layer is off: settings read from the environment as before and
preferences stay in the browser. Per-app configuration (both Config tabs) stays where it is; the one
link between the two is the pipeline Config tab's "Use console default", which copies the console's
default model id into the pipeline's own parameter through its normal PUT. §14 of
`docs/deal-pipeline-design.md` is the design.

## Sign-in

Three providers, chosen by `NEXT_PUBLIC_AUTH_PROVIDER` at **build** time in the container (Next.js
inlines every `NEXT_PUBLIC_*`) and by `AUTH_PROVIDER` at run time for the server half. `AuthWrapper`
(`src/components/AuthWrapper.tsx`) is the switch; each branch is a wrapper with the same shape — a
client-hydration guard, a pass-through for local dev and unconfigured builds, and children rendered
only once there is a session.

| Value                  | Flow                                                                                                              | Redirect route     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------ |
| **`cognito`** (default) | Cognito hosted UI, OAuth authorization code + PKCE, **no SDK** — `src/lib/auth/cognito-pkce.ts` over the platform `crypto` and `fetch` | `/callback`        |
| `okta`                 | `@okta/okta-auth-js` redirect flow, with `src/lib/okta-renew.ts` for silent renewal                                | `/login/callback`  |
| `entra`                | MSAL, returning to the app's own origin                                                                            | none               |

The default lives in **one** place per side and the two mirror each other:
`DEFAULT_AUTH_PROVIDER` in `src/lib/auth/provider.ts` for the browser, `resolveApiAuth` in
`src/lib/api-auth.ts` for the server. Four modules used to carry their own
`process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "entra"` — the gate, `client-token.ts`, `reauth.ts` and
`UserMenu` — and four copies of a default is one too many the moment the default changes: a build whose
gate signs in with Cognito while the token reader looks for an MSAL account renders the app and then
401s every call, with nothing on screen to say why. Unset or blank means `cognito`; an unrecognised
value still resolves to Entra in the browser (compatibility — `"Okta"` picked Entra before Cognito
existed) and to `misconfigured` on the server, which the proxy turns into a **503, never an open door**.

**The Cognito path, in the four files that own it.** `cognito-pkce.ts` builds the
`/oauth2/authorize` URL with an S256 challenge and a per-attempt `state`, exchanges the code at
`/oauth2/token` with no client secret (the app client is public — PKCE is what replaces the secret),
and refreshes **on read** rather than on a timer, so every BFF call renews a token that has aged out.
Tokens live in `sessionStorage`, per tab, cleared when the tab closes: the refresh token therefore does
not outlive the tab, and the cost is that a new tab bounces through `/oauth2/authorize` once — silently,
while the pool's own first-party session cookie on the hosted-UI domain is still valid.
`CognitoAuthWrapper.tsx` drives it and completes the `?code=` exchange itself, because it renders before
every page and would otherwise send the browser back to `/authorize` while sitting on the callback URL;
`src/app/callback/page.tsx` only forwards the now-authenticated user to where they were going.
`api-auth.ts` verifies the resulting ID token against the same pool — issuer derived as
`https://cognito-idp.<region>.amazonaws.com/<pool-id>`, **not** the hosted-UI domain — and additionally
pins `token_use`.

Two things to know before touching any of this:

- **`localhost` and `127.0.0.1` pass through unauthenticated**, in all three wrappers. So `npm run dev`
  renders immediately and no provider redirect is *started* by the gate. With `ALLOW_ANONYMOUS_API=true`
  that is the whole local story. Without it, the app renders, the first BFF call goes with no
  `Authorization` header, the 401 backstop in `src/lib/reauth.ts` starts the hosted-UI redirect, and it
  completes only because the deployment registered `http://localhost:3000/callback` on the app client
  (`cognito_local_dev_callbacks`). That is the sequence to expect when debugging a laptop sign-in — and
  it is why the Cognito gate checks for a `?code=`/`?error=` callback **before** its pass-through, unlike
  the other two: a laptop that arrives on `/callback` holding a real code has to be allowed to finish,
  or the 401 that started the redirect simply repeats. A local page load with no callback in the URL
  still passes straight through, and the gate never redirects a laptop by itself.
- **`AUTH_GROUPS_CLAIM` is per-provider, not a constant.** A user pool emits group membership as the
  reserved claim `cognito:groups`; Okta and Entra release `groups` (or `roles`). `groupsFrom` defaults
  by mode and an explicit `AUTH_GROUPS_CLAIM` always wins — which is what a **federated** pool needs,
  because a SAML/OIDC provider mapped into the pool commonly lands its groups on `custom:groups`
  instead. The repository README's "Authentication" section is the federation and cost guide.

`frontend/.env.example` documents every name on both sides, and
`terraform output -raw frontend_env_local` in `infra/environments/recon` renders a complete
`.env.local` for a laptop run against a real deployment.

## The BFF exists because the browser must not hold credentials

Every route under `api/recon/` and `api/pipeline/` is same-origin and runs as the task role.
`src/proxy.ts` gates both prefixes, verifying the token and matching the caller's groups against that
app's access group, so an unauthenticated or unentitled request never reaches a route file.

That gate has a consequence worth knowing before you touch anything that displays a file: **neither
`<iframe src>` nor `<img src>` can carry an `Authorization` header.** So binary content is fetched
with `reconFetch`, wrapped in an object URL, and handed to the element — see
`SourceDocumentPreview` and `AuthedImage`. Pointing an element straight at a route returns 401, and
exempting the route from the gate would leave raw customer financial documents as the one open door.

Two things follow from that, both of which have already broken the preview once each:

- The CSP must allow `blob:` in **`frame-src`**, not only `img-src`. With no `frame-src` the
  directive falls back to `default-src 'self'` and Chrome renders the refusal as a torn-page icon —
  which reads as a corrupt document, not a blocked one. The policy lives in
  `infra/modules/frontend-ecs`, not in `next.config.js`.
- S3 stamps `binary/octet-stream` on objects uploaded without an explicit content type, so
  `ContentType ?? fallback` never fires. Treat the generic types as "unknown" and fall back to the
  key's extension.

## Two panels whose job is to explain a number

`case/[id]` is not a form. The Evidence Score is a fraction of the classified skill's _required_
steps, and the panels beneath it exist so an analyst can see why it is what it is — the per-step
table, and the notices the investigation matched, each expandable to its extracted fields beside the
source document.

**Matched Notices never re-reads the notice table**, deliberately. Its rows come from the case's
persisted `notice_search` — the full result set the agent _saw_ — with the trace as a best-effort
fallback for a case that persisted none, since a trace's `tool_output` is only a 600-character
display summary. Re-reading the table would show the notice as it is now. An empty match is
rendered rather than hidden, because "no notice matched"
is usually the reason three evidence steps returned nothing.

## Screens and screenshots

`assets/img/` holds a capture of every screen, refreshed with
`scripts/capture_ui_screenshots.py`. See [`scripts/README.md`](../scripts/README.md) for why it
attaches to a running Chrome instead of launching one.

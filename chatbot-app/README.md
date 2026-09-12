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
                                  client-token.ts (the browser's ID-token reader), authed-fetch.ts (the
                                  one 401-aware fetch every BFF client is built on), app-admin.ts (the
                                  admin gate every admin-only write route calls, parameterised by app)
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
                                  UserMenu), DataTable, ui.tsx (Panel, Pill, Modal, Notice, buttons)
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
menu, the column-preferences table, the panel/pill/modal primitives), the `src/components/ui/`
primitives and a couple of app-agnostic helpers; each keeps its own nav links, status vocabulary,
hooks and BFF. Who may open which app comes
from identity-provider groups — `RECON_ACCESS_GROUP` / `RECON_ADMIN_GROUP` and `PIPELINE_ACCESS_GROUP`
/ `PIPELINE_ADMIN_GROUP`, resolved by `src/lib/auth/apps.ts`. An unset access group leaves that app
open to every authenticated user, unless `REQUIRE_ACCESS_GROUPS=true`, which the composed deployment
sets whenever the pipeline is enabled: then a blank access group denies the app to everyone but its
admins. An unset admin group means nobody can change it. `PIPELINE_ENABLED=false` switches the
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
behaviour.

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

**Matched Notices reads the trace, not the notice table**, deliberately. `search_notices` records its
full result set in the trace, so the rows are what the agent _saw_; re-reading the table would show
the notice as it is now. An empty match is rendered rather than hidden, because "no notice matched"
is usually the reason three evidence steps returned nothing.

## Screens and screenshots

`assets/img/` holds a capture of every screen, refreshed with
`scripts/capture_ui_screenshots.py`. See [`scripts/README.md`](../scripts/README.md) for why it
attaches to a running Chrome instead of launching one.

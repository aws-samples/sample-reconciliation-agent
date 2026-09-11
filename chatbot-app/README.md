# `chatbot-app/` — the operator console

A Next.js app that is both the UI and its own backend-for-frontend, hosting two applications behind
one shell: Trade Reconciliation (`/recon`, BFF `/api/recon`) and Deal Pipeline (`/pipeline`, BFF
`/api/pipeline`). `/` is the landing chooser and a collapsible app rail switches between the apps the
viewer may open. It runs as one Fargate task behind an ALB and CloudFront (`infra/modules/frontend-ecs`),
or locally with `npm run dev`.

```
frontend/src/app/page.tsx         the landing chooser; /api/me reports the viewer's per-app access
frontend/src/lib/auth/apps.ts     the app registry: paths, BFF prefixes, access + admin group names
frontend/src/proxy.ts             the gate in front of both BFFs

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

frontend/__tests__/               vitest, mirroring the trees above
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
`src/lib/api-auth.ts`, `src/lib/reauth.ts`), the `src/components/ui/` primitives and a couple of
app-agnostic helpers; each keeps its own theme CSS, nav, hooks and BFF. Who may open which app comes
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

Admin gating differs between the apps, and it matters for what an access group buys. Every pipeline
write route re-checks `PIPELINE_ADMIN_GROUP`. On the recon side only `config/*`, `memory` DELETE and
`uploads` do; `system-prompt`, `skills`, `harness/configs`, `evals/batch` and bulk `cases` writes are
open to anyone the proxy admits, so `RECON_ACCESS_GROUP` is the real boundary on the recon agent's
behaviour.

Because the pipeline BFF shares the process with recon's, it reads only `PIPELINE_ASSETS_BUCKET`,
`PIPELINE_AGENT_MODEL_PARAM` and `PIPELINE_SKILLS_PREFIX` — never the bare names, which in the
container are recon's and all exist, so a fallback would silently read recon's bucket. Its sample
emails come from `data/deal-emails` when that directory exists and from S3 under
`PIPELINE_SAMPLES_PREFIX` when it does not (`src/lib/pipeline/server/samples.ts`).

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

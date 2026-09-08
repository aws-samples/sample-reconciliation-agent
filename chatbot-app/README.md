# `chatbot-app/` — the operator console

A Next.js app that is both the UI and its own backend-for-frontend. `frontend/src/app/api/recon/*`
holds server routes; `frontend/src/app/recon/*` holds the screens. It runs as a Fargate task behind
an ALB and CloudFront (`infra/modules/frontend-ecs`).

```
frontend/src/app/recon/          screens: dashboard, queue, case/[id], skills, lessons, evals,
                                 idp-documents, config
frontend/src/app/api/recon/      the BFF — every AWS call the browser cannot make itself
frontend/src/components/recon/   the console's own components
frontend/src/lib/                clients, stores and policy helpers
frontend/__tests__/              vitest, mirroring the two trees above
```

```bash
cd frontend
npx vitest run          # the suite
npx tsc --noEmit        # typecheck
npx prettier --check .  # formatting
```

Repo-wide ESLint is broken; `prettier` + `tsc` are the local gate and CI's `frontend` job is the real
one.

## The BFF exists because the browser must not hold credentials

Every route under `api/recon/` is same-origin and runs as the task role. `src/proxy.ts` gates
`/api/recon/*`, so an unauthenticated request never reaches a route file.

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

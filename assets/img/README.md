# `assets/img/` — UI screenshots

One capture per screen of the operator console, in nav order. Referenced from the top-level
`README.md`.

Regenerate against a live deployment:

```bash
python3 scripts/capture_ui_screenshots.py --base-url https://<distribution>.cloudfront.net
```

Captured at a **1440×900 viewport, not full page**. A 4000px-tall image of a scrolling table is
unreadable at README width, and the first screenful is what a reader needs to recognise the screen.
Pass `--full-page` for the two where the long content is the point.

⚠️ **Check what you committed.** The script attaches to a signed-in Chrome over CDP, and the Okta
session is short lived enough to expire _mid-run_. An earlier version verified authentication once at
startup and wrote seven pictures of the login wall — which is worse than failing, because a login
page is a plausible-looking screenshot nobody questions in a README. The script now re-checks before
every capture and skips rather than writing a wall, but open one image before you commit anyway.

`recon-ops-dashboard.png` predates the numbered set and is kept because the top-level README links to
it.

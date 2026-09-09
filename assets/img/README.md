# `assets/img/` — UI screenshots

One capture per screen of the operator console, in nav order, plus two framed on panels that sit
below the fold of the screen they belong to: `10-` (how a Tier-1 case auto-cleared) and `11-` (the
Tier-2 model selection). `demo.gif` is the whole set animated and is what the top-level `README.md`
embeds; the stills are kept because a reader who wants one screen should not have to pause a GIF.

Regenerate against a live deployment:

```bash
python3 scripts/capture_ui_screenshots.py --base-url https://<distribution>.cloudfront.net \
    --tier1-case <an-auto-cleared-item-id>
```

`--tier1-case` is optional and `10-` is skipped without it: an auto-cleared case is by definition not
in the queue, so it cannot be discovered the way the others are — seed one and name it. Then rebuild
the GIF from the numbered stills, 2.5s a frame.

Captured at a **1440×900 viewport, not full page**. A 4000px-tall image of a scrolling table is
unreadable at README width, and the first screenful is what a reader needs to recognise the screen.
Pass `--full-page` for the two where the long content is the point.

⚠️ **Check what you committed.** The script attaches to a signed-in Chrome over CDP, and the Okta
session is short lived enough to expire _mid-run_. An earlier version verified authentication once at
startup and wrote seven pictures of the login wall — which is worse than failing, because a login
page is a plausible-looking screenshot nobody questions in a README. The script now re-checks before
every capture and skips rather than writing a wall, but open one image before you commit anyway.

That warning applies to `demo.gif` too, and more so: a wall frame buried at position seven of eleven
is far easier to miss than a single still.

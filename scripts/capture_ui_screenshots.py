#!/usr/bin/env python3
"""Capture a screenshot of every recon UI screen into ``assets/img/``.

Attaches to a RUNNING Chrome over CDP rather than launching one, for the same reason
``live_qa.py`` does: every screen behind ``/recon`` is gated by ``src/proxy.ts`` and the deployment
authenticates through Okta, so a fresh browser lands on the login wall. See that script's module
docstring for how to start Chrome with a debugging port.

Deliberately viewport-sized and NOT full-page. These images go in the README, where a 4000px-tall
capture of a scrolling table is unreadable; the first screenful is what a reader needs to recognise
the screen. ``--full-page`` is available for the two screens where the point IS the long content.

Read-only: it navigates and screenshots. The one interaction is expanding a collapsed panel on the
case screen, because the expanded state is the thing worth documenting.

Usage::

    python3 scripts/capture_ui_screenshots.py --base-url https://<distribution>.cloudfront.net
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Page, sync_playwright

# The distribution the console is served from, matched as a host suffix. See `on_app`.
APP_HOST_SUFFIX = ".cloudfront.net"

# 1440x900 is the smallest common laptop viewport this UI is designed against, so a capture at this
# size is the honest "what you see when you open it" rather than a wide-monitor best case.
VIEWPORT = {"width": 1440, "height": 900}

# (filename stem, path, optional post-load action). The stems double as the README's image names, so
# they are kebab-case and prefixed to sort in nav order rather than alphabetically.
SCREENS: list[tuple[str, str]] = [
    ("01-dashboard", "/recon/dashboard"),
    ("02-queue", "/recon/queue"),
    ("03-skills", "/recon/skills"),
    ("04-lessons", "/recon/lessons"),
    ("05-evals", "/recon/evals"),
    ("06-documents", "/recon/idp-documents"),
    ("07-config", "/recon/config"),
]


def settle(page: Page, timeout: int = 30_000) -> None:
    """Wait for the screen's own data fetches to finish, tolerating a never-idle page.

    The recon screens fetch after mount and some poll, so ``networkidle`` can legitimately never
    arrive. A timeout here is not a failure — the capture below is still the loaded screen.

    :param page: the page to wait on.
    :param timeout: milliseconds to allow.
    """
    try:
        page.wait_for_load_state("networkidle", timeout=timeout)
    except Exception:  # noqa: BLE001 - see docstring; the screenshot is taken either way
        pass
    page.wait_for_timeout(1_200)


def on_app(page: Page) -> bool:
    """Report whether the app itself is on display, rather than the identity provider.

    The host is matched as a SUFFIX rather than searched for in the whole URL: a provider page
    carrying the console's address in a `?next=` parameter contains the string while being exactly
    the state this function exists to reject.

    :param page: the page to inspect.
    :returns: True when the current document is a recon screen.
    """
    host = (urlsplit(page.url).hostname or "").lower()
    return host.endswith(APP_HOST_SUFFIX) and "Sign In" not in page.title()


def await_app(page: Page, attempts: int = 30) -> bool:
    """Wait out a silent Okta round trip.

    ⚠️ Called before EVERY screenshot, not once at startup. The provider session here is short lived
    and expires mid-run, so authenticating once and then capturing a whole run writes pictures of the
    login wall -- which is worse than failing, because a login wall is a plausible-looking screenshot
    that a reader would not question in a README.

    :param page: the page to wait on.
    :param attempts: 3-second polls to allow.
    :returns: True once the app is on display.
    """
    for _ in range(attempts):
        if on_app(page):
            settle(page)
            return True
        page.wait_for_timeout(3_000)
    return False


def authenticate(page: Page, base: str) -> bool:
    """Drive the first navigation and wait out the silent Okta round trip.

    :param page: the page to drive.
    :param base: deployment base URL.
    :returns: True once a recon screen is on display.
    """
    page.goto(f"{base}/recon/dashboard", wait_until="domcontentloaded", timeout=60_000)
    return await_app(page)


def capture_case_detail(page: Page, base: str, out: Path, full_page: bool) -> list[str]:
    """Capture the case screen, and again with a matched notice expanded.

    Two images because the expanded state is where the evidence actually is: the collapsed row shows
    a summary line, and the panel's whole purpose is the extracted fields beside the source document.

    :param page: the page to drive.
    :param base: deployment base URL.
    :param out: output directory.
    :param full_page: capture the whole scroll height rather than the viewport.
    :returns: the filenames written.
    """
    written: list[str] = []
    page.goto(f"{base}/recon/queue", wait_until="domcontentloaded", timeout=45_000)
    settle(page)
    if not await_app(page):
        print("  ! case detail: still at the identity provider", file=sys.stderr)
        return written
    # The queue's rows are divs with no href, but the item id is rendered as text -- so the id is
    # read off the page and navigated to directly.
    ids = re.findall(r"\b(?:RECON-[A-Z0-9-]+|verify-[a-z0-9-]+)\b", page.inner_text("body"))
    if not ids:
        print("  ! no case ids on the queue screen; skipping case detail", file=sys.stderr)
        return written

    page.goto(f"{base}/recon/case/{ids[0]}", wait_until="domcontentloaded", timeout=45_000)
    settle(page)
    if not await_app(page):
        return written
    page.screenshot(path=str(out / "08-case-detail.png"), full_page=full_page)
    written.append("08-case-detail.png")

    # Expand the first collapsed disclosure -- the matched-notice row -- and frame the panel.
    #
    # Scrolled to BEFORE the click, and by heading rather than by the button: clicking flips
    # aria-expanded to "true", so a `[aria-expanded="false"]` locator resolved afterwards waits 30s
    # for an element that no longer exists.
    heading = page.get_by_text("MATCHED NOTICES", exact=False).first
    row = page.locator('button[aria-expanded="false"]').first
    if row.count() == 0:
        return written
    if heading.count():
        heading.scroll_into_view_if_needed()
    row.click()
    # The preview inside the expanded row fetches the source document, so give it time to paint --
    # an image captured mid-fetch shows a spinner where the document should be.
    page.wait_for_timeout(6_000)
    if heading.count():
        heading.scroll_into_view_if_needed()
    page.screenshot(path=str(out / "09-case-matched-notice-expanded.png"), full_page=full_page)
    written.append("09-case-matched-notice-expanded.png")
    return written


def capture_tier1_resolution(
    page: Page, base: str, out: Path, full_page: bool, item_id: str
) -> list[str]:
    """Capture a deterministically auto-cleared case, framed on its resolution evidence.

    Taken from an item id supplied on the command line rather than discovered from the queue: an
    auto-cleared case is not IN the queue -- that is the point of it -- and the dashboard's counts
    do not link to a specific one. So the caller seeds a Tier-1 item during the live QA run and
    names it here.

    :param page: the page to drive.
    :param base: deployment base URL.
    :param out: output directory.
    :param full_page: capture the whole scroll height rather than the viewport.
    :param item_id: the auto-cleared item to open.
    :returns: the filenames written.
    """
    page.goto(f"{base}/recon/case/{item_id}", wait_until="domcontentloaded", timeout=45_000)
    settle(page)
    if not await_app(page):
        print("  ! tier-1 case: still at the identity provider", file=sys.stderr)
        return []
    # Fail loudly rather than writing a picture of an escalated case labelled as an auto-clear: the
    # panel is what this capture exists to show, so its absence means the wrong id was passed.
    heading = page.get_by_text("Tier-1 Deterministic Resolution", exact=False).first
    if heading.count() == 0:
        print(f"  ! {item_id} shows no Tier-1 resolution panel; NOT captured", file=sys.stderr)
        return []
    heading.scroll_into_view_if_needed()
    page.screenshot(path=str(out / "10-case-tier1-auto-cleared.png"), full_page=full_page)
    return ["10-case-tier1-auto-cleared.png"]


def capture_config_model(page: Page, base: str, out: Path, full_page: bool) -> list[str]:
    """Capture the Config screen framed on the Tier-2 model selection.

    A second Config image, because `07-config.png` is the top of that screen and the model row sits
    below the fold -- so the tab's own screenshot cannot show it without becoming a 3000px scroll
    that reads as nothing in a README.

    :param page: the page to drive.
    :param base: deployment base URL.
    :param out: output directory.
    :param full_page: capture the whole scroll height rather than the viewport.
    :returns: the filenames written.
    """
    page.goto(f"{base}/recon/config", wait_until="domcontentloaded", timeout=45_000)
    settle(page)
    if not await_app(page):
        print("  ! config model: still at the identity provider", file=sys.stderr)
        return []
    # Anchored on the row's own prose rather than the word "Model", which also labels the harness
    # config's read-only summary further down and would frame the wrong panel.
    row = page.get_by_text("Which Anthropic model the Tier-2 agent invokes", exact=False).first
    if row.count() == 0:
        print("  ! no model-selection row on the Config screen; NOT captured", file=sys.stderr)
        return []
    row.scroll_into_view_if_needed()
    page.wait_for_timeout(800)
    page.screenshot(path=str(out / "11-config-model-selection.png"), full_page=full_page)
    return ["11-config-model-selection.png"]


def main() -> int:
    """Capture every screen and report what was written.

    :returns: 0 on success, 1 when the browser could not be reached or authenticated.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", required=True, help="deployment origin, no trailing slash")
    parser.add_argument("--cdp", default="http://127.0.0.1:9222", help="Chrome DevTools endpoint")
    parser.add_argument("--out", default="assets/img", help="directory to write PNGs into")
    parser.add_argument(
        "--full-page",
        action="store_true",
        help="capture the full scroll height instead of the viewport",
    )
    parser.add_argument(
        "--tier1-case",
        default=None,
        help="item id of an auto-cleared case, to capture its Tier-1 resolution evidence",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(args.cdp)
        except Exception as err:  # noqa: BLE001 - the remedy is the message
            print(f"could not attach to Chrome at {args.cdp}: {err}", file=sys.stderr)
            return 1

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        page.set_viewport_size(VIEWPORT)

        if not authenticate(page, base):
            print("still at the identity provider; sign in and re-run", file=sys.stderr)
            return 1

        written: list[str] = []
        for stem, path in SCREENS:
            page.goto(f"{base}{path}", wait_until="domcontentloaded", timeout=45_000)
            settle(page)
            if not await_app(page):
                print(f"  ! {stem}: still at the identity provider, NOT captured", file=sys.stderr)
                continue
            page.screenshot(path=str(out / f"{stem}.png"), full_page=args.full_page)
            written.append(f"{stem}.png")
            print(f"  {stem}.png")

        for name in capture_case_detail(page, base, out, args.full_page):
            print(f"  {name}")
            written.append(name)

        for name in capture_config_model(page, base, out, args.full_page):
            print(f"  {name}")
            written.append(name)

        if args.tier1_case:
            for name in capture_tier1_resolution(page, base, out, args.full_page, args.tier1_case):
                print(f"  {name}")
                written.append(name)

        page.close()

    print(f"\n{len(written)} screenshots in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

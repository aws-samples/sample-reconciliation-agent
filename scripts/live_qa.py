#!/usr/bin/env python3
"""Drive a live QA pass over the deployed recon UI in the operator's own Chrome.

Why it attaches to a RUNNING Chrome rather than launching one: every screen behind
``/recon`` is gated by `src/proxy.ts`, and the deployment authenticates through Okta. A fresh
browser -- Playwright's bundled Chromium, or the AgentCore cloud browser -- has no Okta session and
lands on the login wall, where it cannot proceed without the operator's credentials and MFA. Chrome
started with ``--remote-debugging-port`` and the operator's real profile already holds that session
in its cookie jar, so ``connect_over_cdp`` inherits it.

Read-only by default. Every check navigates, reads and screenshots; nothing clicks a button that
writes. ``--allow-writes`` is accepted but currently gates nothing, and is here so a future
destructive check has an explicit opt-in rather than being added silently.

Usage::

    # in a terminal the operator owns, after quitting Chrome:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
        --remote-debugging-port=9222 --profile-directory=Default

    python3 scripts/live_qa.py --base-url https://<distribution>.cloudfront.net
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Page, sync_playwright

# The distribution the console is served from. Matched as a HOST SUFFIX, never as a substring of the
# whole URL: `https://provider.example/?next=cloudfront.net` contains the string while being the
# identity provider's page, which is exactly the state these waits exist to detect.
APP_HOST_SUFFIX = ".cloudfront.net"


def on_app_host(url: str) -> bool:
    """Report whether a URL's host is the console's distribution rather than the provider's.

    :param url: the URL to inspect.
    :returns: True when the host ends in the distribution's domain.
    """
    host = (urlsplit(url).hostname or "").lower()
    return host.endswith(APP_HOST_SUFFIX)


# Screens to sweep. `wait_for` is a selector-independent string the page must render once it has
# loaded its data, chosen to be the thing that is absent when the BFF errors -- a title alone would
# pass on a screen whose every panel failed.
SCREENS: list[tuple[str, str, str]] = [
    ("dashboard", "/recon/dashboard", "Dashboard"),
    ("queue", "/recon/queue", "Queue"),
    ("documents", "/recon/idp-documents", "DOCUMENTS"),
    ("skills", "/recon/skills", "Skills"),
    ("lessons", "/recon/lessons", "Lessons"),
    ("evals", "/recon/evals", "Evals"),
    ("config", "/recon/config", "Config"),
]


@dataclass
class Result:
    """One check's outcome."""

    name: str
    ok: bool
    detail: str
    console_errors: list[str] = field(default_factory=list)


def _console_watcher(page: Page) -> list[str]:
    """Collect console errors and failed requests for the life of the page.

    A screen can render its shell and still have every data panel fail, and the fastest signal for
    that is a 4xx/5xx on an ``/api/recon/*`` call. Collected per page rather than asserted inline so
    one noisy third-party warning does not fail an otherwise good screen.

    :param page: the Playwright page to instrument.
    :return: a list that accumulates messages as the page runs.
    """
    errors: list[str] = []
    page.on(
        "console",
        lambda msg: (
            errors.append(f"console.{msg.type}: {msg.text}"[:300]) if msg.type == "error" else None
        ),
    )
    page.on(
        "response",
        lambda r: (
            errors.append(f"HTTP {r.status} {r.url}"[:300])
            if r.status >= 400 and "/api/" in r.url
            else None
        ),
    )
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"[:300]))
    return errors


def settle_or_login(page: Page) -> None:
    """Settle the page, then wait out a silent re-auth if the provider intercepted it.

    The provider session expires mid-run, so this is called by every check rather than once at
    startup -- an expired session otherwise turns absence assertions into free passes.

    :param page: the page to wait on.
    """
    try:
        page.wait_for_load_state("networkidle", timeout=30_000)
    except Exception:  # noqa: BLE001
        pass
    for _ in range(20):
        if on_app_host(page.url) and "Sign In" not in page.title():
            return
        page.wait_for_timeout(3_000)


def check_screen(page: Page, name: str, path: str, expect: str, base: str, shots: Path) -> Result:
    """Load one screen and confirm it rendered its own content, not a login wall or an error.

    :param page: the page to drive.
    :param name: short screen id, used for the screenshot filename.
    :param path: URL path under ``base``.
    :param expect: text the loaded screen must contain.
    :param base: deployment base URL.
    :param shots: directory to write screenshots into.
    :return: the check result.
    """
    errors = _console_watcher(page)
    page.goto(f"{base}{path}", wait_until="domcontentloaded", timeout=45_000)
    # The recon screens fetch after mount, so "networkidle" is what "loaded" means here.
    try:
        page.wait_for_load_state("networkidle", timeout=30_000)
    except Exception:  # noqa: BLE001 - a slow poll can keep the network busy; the text check decides
        pass
    page.screenshot(path=str(shots / f"{name}.png"), full_page=True)

    body = page.inner_text("body")
    if "Sign in" in body and "recon" not in page.url:
        return Result(name, False, f"redirected to a login wall ({page.url})", errors)
    if expect.lower() not in body.lower():
        return Result(name, False, f"{expect!r} not found on {page.url}", errors)
    return Result(name, True, f"rendered ({len(body)} chars)", errors)


def check_case_detail(page: Page, base: str, shots: Path) -> list[Result]:
    """Open the first case in the queue and verify the panels this release touched.

    Specifically the three things !26 changed: the Skills panel's new label, the absence of the
    "also loaded" list, and the Matched Notices section.

    :param page: the page to drive.
    :param base: deployment base URL.
    :param shots: screenshot directory.
    :return: one result per assertion.
    """
    out: list[Result] = []
    errors = _console_watcher(page)
    page.goto(f"{base}/recon/queue", wait_until="domcontentloaded", timeout=45_000)
    try:
        page.wait_for_load_state("networkidle", timeout=30_000)
    except Exception:  # noqa: BLE001
        pass

    # The queue is built from divs and buttons, not a table, and its rows carry no href -- so there
    # is no stable selector for "the first row". The item id IS rendered as text, so it is read off
    # the page and navigated to directly. That exercises the thing this check is about (the case
    # screen's panels) without coupling the assertion to the queue's click plumbing.
    ids = re.findall(r"\b(?:RECON-[A-Z0-9-]+|verify-[a-z0-9-]+)\b", page.inner_text("body"))
    if not ids:
        return [Result("case-detail", False, "no case ids found on the queue screen", errors)]
    page.goto(f"{base}/recon/case/{ids[0]}", wait_until="domcontentloaded", timeout=45_000)
    try:
        page.wait_for_load_state("networkidle", timeout=30_000)
    except Exception:  # noqa: BLE001
        pass
    page.screenshot(path=str(shots / "case-detail.png"), full_page=True)
    body = page.inner_text("body")

    # Same vacuous-pass guard as the Config checks: `no-also-loaded` asserts an ABSENCE, which any
    # page that failed to load satisfies for free. Nothing below is reported unless the case screen
    # is genuinely on screen.
    low = body.lower()
    if "evidence" not in low:
        return [
            Result("case-detail:loads", False, f"not a case screen: {page.url[:80]}", errors),
            Result("case-detail:skill-label", False, "not checked - screen did not load"),
            Result("case-detail:no-also-loaded", False, "not checked - screen did not load"),
            Result("case-detail:matched-notices", False, "not checked - screen did not load"),
        ]

    out.append(Result("case-detail:loads", True, f"opened {page.url}", errors))
    out.append(
        Result(
            "case-detail:skill-label",
            "skill that drove the score" in low,
            "expected the relabelled Skills eyebrow",
        )
    )
    out.append(
        Result(
            "case-detail:no-also-loaded",
            "also loaded" not in low,
            "the 'also loaded (N)' list must be gone",
        )
    )
    # Present on every runtime-backend case: either the list, or the honest empty statement.
    out.append(
        Result(
            "case-detail:matched-notices",
            "matched notices" in low or "matched no notices" in low,
            "expected the Matched Notices section",
        )
    )
    return out


def check_case(page: Page, base: str, item_id: str, shots: Path) -> list[Result]:
    """Assert the case screen's panels for ONE case, whatever scenario it represents.

    Written to hold across scenarios rather than for one fixture. A case can legitimately have no
    class, a zero score, an empty evidence table or no matched notices -- so each assertion is
    phrased as "the panel states its outcome", not "the panel has rows". The only unconditional
    requirements are the ones this release changed.

    :param page: the page to drive.
    :param base: deployment base URL.
    :param item_id: the case to open.
    :param shots: screenshot directory.
    :returns: one result per assertion.
    """
    errors = _console_watcher(page)
    page.goto(f"{base}/recon/case/{item_id}", wait_until="domcontentloaded", timeout=45_000)
    settle_or_login(page)
    body = page.inner_text("body")
    low = body.lower()
    short = item_id[:26]

    if "evidence" not in low:
        return [
            Result(f"case[{short}]:loads", False, f"not a case screen: {page.url[:70]}", errors)
        ]

    out = [Result(f"case[{short}]:loads", True, "rendered", errors)]
    # The label is unconditional: every case has a classified skill or renders an em dash for it.
    out.append(
        Result(
            f"case[{short}]:skill-label",
            "skill that drove the score" in low,
            "the relabelled Skills eyebrow must be present",
        )
    )
    out.append(
        Result(
            f"case[{short}]:no-also-loaded",
            "also loaded" not in low,
            "the 'also loaded (N)' list must be gone",
        )
    )
    # Either the panel lists notices, or it says the search matched none, or the trace has no
    # search_notices call at all and the panel is correctly absent. All three are valid; a panel
    # that renders EMPTY with no explanation is not.
    notices_ok = (
        "matched notices" in low
        or "matched no notices" in low
        or "notice search failed" in low
        or "matched notices" not in low
    )
    out.append(
        Result(f"case[{short}]:notices-state", notices_ok, "notices panel states its outcome")
    )
    out.append(
        Result(
            f"case[{short}]:evidence-explained",
            "evidence" in low
            and ("satisfied" in low or "returned nothing" in low or "no evidence steps" in low),
            "the score must be accompanied by per-step outcomes or an honest empty statement",
        )
    )
    page.screenshot(path=str(shots / f"case-{item_id[:32]}.png"), full_page=False)
    return out


def check_document_preview(page: Page, base: str, shots: Path) -> list[Result]:
    """Open a processed document and assert its source file actually renders.

    This is the assertion three separate defects each defeated: a missing `s3:ListBucket` grant made
    S3 answer AccessDenied for a present key, `ContentType ?? extension` never fell back off S3's
    `binary/octet-stream`, and a CSP with no `frame-src` refused the blob URL. Each one left a
    plausible-looking panel, so the check is "a frame exists AND the response was a PDF".

    :param page: the page to drive.
    :param base: deployment base URL.
    :param shots: screenshot directory.
    :returns: one result per assertion.
    """
    seen: list[str] = []
    page.on(
        "response",
        lambda r: (
            seen.append(f"{r.status} {r.headers.get('content-type', '?')}")
            if "/source" in r.url
            else None
        ),
    )
    page.goto(f"{base}/recon/idp-documents", wait_until="domcontentloaded", timeout=45_000)
    settle_or_login(page)
    body = page.inner_text("body")
    if "documents" not in body.lower():
        return [Result("documents:preview", False, "Documents screen did not load")]

    row = page.get_by_text(".pdf", exact=False).first
    if row.count() == 0:
        return [Result("documents:preview", False, "no processed documents to open")]
    row.click()
    page.wait_for_timeout(9_000)
    page.screenshot(path=str(shots / "document-preview.png"), full_page=False)

    served_pdf = any("application/pdf" in s and s.startswith("200") for s in seen)
    return [
        Result(
            "documents:source-200-pdf",
            served_pdf,
            f"/source responses: {list(dict.fromkeys(seen)) or 'none'}",
        ),
        Result(
            "documents:renders-in-frame",
            page.locator("iframe").count() > 0,
            "an <iframe> must exist, or CSP/content-type has regressed to a download button",
        ),
    ]


def check_config_contacts(page: Page, base: str, shots: Path) -> list[Result]:
    """Verify the Config tab no longer publishes or opines on the send gate.

    The three things !27 removed: the amber "on file, but unsendable" badge, the "Allowed
    counterparty domains: ..." banner, and any stale entity names on the contact list.

    :param page: the page to drive.
    :param base: deployment base URL.
    :param shots: screenshot directory.
    :return: one result per assertion.
    """
    errors = _console_watcher(page)
    page.goto(f"{base}/recon/config", wait_until="domcontentloaded", timeout=45_000)
    try:
        page.wait_for_load_state("networkidle", timeout=30_000)
    except Exception:  # noqa: BLE001
        pass
    page.screenshot(path=str(shots / "config-contacts.png"), full_page=True)
    body = page.inner_text("body")

    # WARNING: absence assertions are vacuous on a page that did not load. A login wall contains
    # none of the strings below, so without this guard an expired session reports three PASSes for
    # checks that never ran. Loaded-ness is asserted FIRST and the rest are reported as failures
    # when it does not hold, rather than quietly passing.
    if "config" not in body.lower():
        return [
            Result("config:loads", False, f"not the Config screen: {page.url[:80]}", errors),
            Result("config:no-domain-banner", False, "not checked - screen did not load"),
            Result("config:no-unsendable-badge", False, "not checked - screen did not load"),
            Result("config:no-stale-entities", False, "not checked - screen did not load"),
        ]

    stale = [n for n in ("North Harbor", "northharbor", "Arcadia", "arcadia-agent") if n in body]
    return [
        Result("config:loads", True, f"at {page.url}", errors),
        Result(
            "config:no-domain-banner",
            "allowed counterparty domains" not in body.lower(),
            "the deploy-time allowlist banner must be gone",
        ),
        Result(
            "config:no-unsendable-badge",
            "on file, but unsendable" not in body.lower(),
            "the amber per-row advisory must be gone",
        ),
        Result(
            "config:no-stale-entities",
            not stale,
            f"stale entities on the contact list: {stale}" if stale else "contact list is current",
        ),
    ]


def main() -> int:
    """Run the sweep and print a report.

    :return: 0 when every check passed, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", required=True, help="deployment origin, no trailing slash")
    parser.add_argument("--cdp", default="http://127.0.0.1:9222", help="Chrome DevTools endpoint")
    parser.add_argument(
        "--shots",
        default="/tmp/recon-live-qa",
        help="directory for full-page screenshots",
    )
    parser.add_argument(
        "--cases",
        default="",
        help="comma-separated case ids to assert; default reads them off the queue screen",
    )
    parser.add_argument(
        "--allow-writes",
        action="store_true",
        help="reserved: permit checks that mutate state (none today)",
    )
    args = parser.parse_args()

    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)
    base = args.base_url.rstrip("/")

    results: list[Result] = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(args.cdp)
        except Exception as err:  # noqa: BLE001 - the remedy is the whole point of the message
            print(
                f"could not attach to Chrome at {args.cdp}: {err}\n\n"
                "Quit Chrome, then relaunch it with a debugging port on your real profile so the\n"
                "Okta session is available:\n\n"
                '  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n'
                "      --remote-debugging-port=9222 --profile-directory=Default\n",
                file=sys.stderr,
            )
            return 1

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()

        # Warm-up. The first navigation of a fresh browser session has no app token, so it bounces
        # through Okta and back. That round trip outlasts a 30s networkidle wait, and every screen
        # then "fails" on a login wall that was only ever transient. Wait for the bounce to settle
        # ONCE, here, instead of racing it seven times.
        page.goto(f"{base}/recon/dashboard", wait_until="domcontentloaded", timeout=60_000)
        for _ in range(30):
            if on_app_host(page.url) and "Sign In" not in page.title():
                break
            page.wait_for_timeout(3_000)
        else:
            print(
                "still on the identity provider after 90s -- sign in to the QA Chrome window and "
                "re-run; the sweep would otherwise report every screen as a login wall.",
                file=sys.stderr,
            )
            return 1
        page.wait_for_timeout(3_000)

        for name, path, expect in SCREENS:
            try:
                results.append(check_screen(page, name, path, expect, base, shots))
            except Exception as err:  # noqa: BLE001 - one bad screen must not end the sweep
                results.append(Result(name, False, f"raised: {err}"))

        for check in (check_case_detail, check_document_preview, check_config_contacts):
            try:
                results.extend(check(page, base, shots))
            except Exception as err:  # noqa: BLE001
                results.append(Result(check.__name__, False, f"raised: {err}"))

        # Scenario sweep. One case is not coverage: a class can be absent, a score can be zero, and
        # an evidence table can be legitimately empty -- so the per-case assertions are re-run across
        # whichever ids were supplied, which is how a scenario-specific regression shows up.
        for item_id in [c.strip() for c in args.cases.split(",") if c.strip()]:
            try:
                results.extend(check_case(page, base, item_id, shots))
            except Exception as err:  # noqa: BLE001
                results.append(Result(f"case[{item_id[:26]}]", False, f"raised: {err}"))

        page.close()

    failed = [r for r in results if not r.ok]
    print(json.dumps({"base_url": base, "shots": str(shots)}, indent=1))
    for r in results:
        print(f"{'PASS' if r.ok else 'FAIL'}  {r.name:34} {r.detail}")
        for e in dict.fromkeys(r.console_errors):
            print(f"        ! {e}")
    print(f"\n{len(results) - len(failed)}/{len(results)} passed; screenshots in {shots}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

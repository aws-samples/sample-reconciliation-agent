import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The CloudFront CSP is `style-src 'self' 'unsafe-inline'` and `font-src 'self' data:` — no host is
// allowlisted, because every font comes from `next/font/google`, which fetches at BUILD time and
// emits @font-face rules pointing at /_next/static/media.
//
// A cross-origin <link rel="stylesheet"> therefore does not degrade — it is blocked, and the only
// symptom is a console error the CSP raises on every page. That is exactly how the Pretendard CDN
// link survived in the root layout unnoticed: nothing rendered differently, because the family was
// only reachable for glyphs (CJK/Hangul) this app never renders. This test is the guard, since jsdom
// enforces no CSP and no rendering assertion would have caught it either.
const SRC = join(__dirname, "..", "..", "src");

/** Absolute URLs loaded as assets by a source file.
 *
 * Only href/src attributes count. A URL inside a comment, a fetch() call or a CSP string is not an
 * asset load, so keying on the attribute avoids flagging legitimate code.
 *
 * @param source - the file's text.
 * @returns the offending absolute URLs; empty when the file loads nothing cross-origin.
 */
function externalAssetUrls(source: string): string[] {
  const matches = source.matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/g);
  return [...matches].map((m) => m[1]);
}

describe("no cross-origin assets in the app shell", () => {
  it("loads no stylesheet, font or script from another origin", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith(".d.ts"))
      .map((f) => join(SRC, f));

    // Guard the guard: a mis-rooted or non-recursive read would make this vacuously green.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.flatMap((file) =>
      externalAssetUrls(readFileSync(file, "utf8")).map(
        (url) => `${file.slice(SRC.length + 1)}: ${url}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});

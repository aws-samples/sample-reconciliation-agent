import { describe, it, expect } from "vitest";
import { escapeHtml } from "@/lib/escapeHtml";

describe("escapeHtml", () => {
  it("neutralizes a title that tries to close the element it sits in", () => {
    // The actual attack this exists to stop: an artifact title is model-supplied, and the print
    // window builds `<title>${title}</title>` by hand.
    const escaped = escapeHtml("</title><script>fetch('//evil')</script>");
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).toBe(
      "&lt;/title&gt;&lt;script&gt;fetch(&#39;//evil&#39;)&lt;/script&gt;",
    );
  });

  it("escapes both quote styles, so a quoted attribute is safe too", () => {
    expect(escapeHtml(`" onload="alert(1)`)).toBe(
      "&quot; onload=&quot;alert(1)",
    );
    expect(escapeHtml("' onload='alert(1)")).toBe("&#39; onload=&#39;alert(1)");
  });

  it("escapes an ampersand once, not twice", () => {
    // `&` handled in the same pass as the rest — escaping it first would yield `&amp;lt;`, which
    // renders as the literal text "&lt;" and looks like a different bug.
    expect(escapeHtml("Q1 P&L <draft>")).toBe("Q1 P&amp;L &lt;draft&gt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Invoice 42 — short payment")).toBe(
      "Invoice 42 — short payment",
    );
  });

  it("returns an empty string for a missing value rather than 'undefined'", () => {
    // Titles are typed as strings but arrive from JSON; printing the word "undefined" into a
    // document header is worse than printing nothing.
    expect(escapeHtml(undefined as unknown as string)).toBe("");
    expect(escapeHtml(null as unknown as string)).toBe("");
  });
});

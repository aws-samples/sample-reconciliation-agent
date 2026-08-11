/**
 * Escape text for interpolation into an HTML template string.
 *
 * React escapes everything it renders, so this is only needed where markup is assembled by hand —
 * currently the print/PDF windows in `components/canvas`, which build a whole document and hand it
 * to `document.write`. The text going in there is model- or document-derived (an artifact title
 * comes from whatever the agent named its output), so it is attacker-influenceable: a title
 * containing `</title><script>` closes the element and runs in a window that inherits the opener's
 * origin, which is where the app's OIDC tokens live.
 */

/** The five characters that can change the meaning of markup in element text or a quoted attribute. */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Replace HTML-significant characters with their entities.
 *
 * `&` is handled by the same pass rather than first, because a single regex replacement never
 * revisits its own output — escaping it separately is the classic way to produce `&amp;lt;`.
 *
 * @param text - the untrusted text; a non-string is coerced so a missing title cannot throw here.
 * @returns the same text, safe to interpolate into element content or a quoted attribute value.
 */
export function escapeHtml(text: string): string {
  return String(text ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

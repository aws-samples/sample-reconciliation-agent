/**
 * What may be uploaded, whatever it is uploaded for.
 *
 * The document pipeline and the knowledge base disagree about almost everything -- where a file
 * lands, what metadata rides along, when it becomes searchable -- but they agree on which files are
 * worth accepting at all, and on what a safe object key looks like. Keeping those two answers here
 * means the two routes cannot drift into separate definitions, which is the failure where a file
 * type is accepted on one path and silently unreadable on the other.
 *
 * The type list is narrow because it is the intersection of what both destinations can actually
 * read, not a guess at what an operator might send. `.xlsx` is the instructive omission: the
 * extraction pipeline handles it, so it looks safe, but this is the upload for NOTICES and a
 * spreadsheet arriving here is more likely a mis-drag than a notice. Widen it deliberately or not
 * at all.
 */

/** Extensions both destinations can read. Lower-case; the check folds case before comparing. */
export const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".msg", ".eml"] as const;

/**
 * Upper bound per object, mirrored from the document pipeline's own presigned-POST condition
 * (`['content-length-range', 1, 104857600]`). Matching it exactly matters: a file this side accepts
 * and that side refuses fails after the audit record is written, which reads as a lost upload.
 */
export const MAX_OBJECT_BYTES = 104857600;

/** The extension, lower-cased, taken from the LAST dot. `""` when the name has no dot. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * Reject a file that must not be uploaded, whatever its workflow type says.
 *
 * @param file - the candidate's name and byte length, as the route received them.
 * @returns null when the file is acceptable, otherwise the reason to show the operator. The reason
 *   names the offending value, because "invalid file" sends someone to read this source.
 */
export function uploadRejectionReason(file: {
  filename: string;
  bytes: number;
}): string | null {
  const ext = extensionOf(file.filename);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `"${ext || file.filename}" is not an accepted type — send one of ${ALLOWED_EXTENSIONS.join(", ")}`;
  }
  // Zero bytes is its own case rather than folding into the range check, because the two have
  // different causes: an empty object is a failed drag or a truncated stream, and saying "must be
  // between 1 byte and 100 MB" about a 0-byte file buries that.
  if (file.bytes <= 0) {
    return "the file is empty — nothing was read from it";
  }
  if (file.bytes > MAX_OBJECT_BYTES) {
    return `the file is larger than 100 MB (${file.bytes} bytes) — the pipeline refuses it too`;
  }
  return null;
}

/**
 * What each accepted extension really is, so the content type is never taken from the client.
 *
 * The browser's own `File.type` looks like the obvious source and is not usable as one. It is
 * derived from the operating system's extension registry on the uploading machine, so it is empty
 * whenever that machine has no association for the extension, and it is whatever the client says
 * when the request does not come from a browser at all -- this is a plain multipart endpoint, so a
 * script can set it freely.
 *
 * Getting it wrong is silent on the knowledge-base route, which is the reason this map exists rather
 * than a `file.type || fallback`. The connector picks its parser from the object's content type; a
 * PDF stored as `application/octet-stream` is ingested with no error, produces no text, and ends up
 * a retrievable document with nothing in it. Nothing downstream reports that, so the operator sees
 * an INGESTED row and an answer that quietly never cites the file they uploaded.
 *
 * The `.msg` and `.eml` entries are here for completeness of the accepted set, not because this path
 * writes them: an email is split by the pre-processor first, and each derived part carries the
 * content type that Lambda chose for it.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".msg": "application/vnd.ms-outlook",
  ".eml": "message/rfc822",
};

/**
 * The content type to store an accepted upload under.
 *
 * @param filename - the file's name; only its extension is read.
 * @returns the content type for that extension.
 * @throws Error when the extension has no mapping. Deliberately not a fallback to
 *   `application/octet-stream`: that value is exactly the outcome this function exists to prevent,
 *   so returning it on the unexpected path would reintroduce the bug at the one moment nobody is
 *   watching. An unmapped extension means `ALLOWED_EXTENSIONS` grew and this map did not, which is a
 *   caller's mistake to fix and not a file to guess about.
 */
export function contentTypeFor(filename: string): string {
  const ext = extensionOf(filename);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    throw new Error(
      `"${ext || filename}" has no known content type — add it to CONTENT_TYPES alongside ALLOWED_EXTENSIONS`,
    );
  }
  return contentType;
}

/**
 * Reduce a client-supplied filename to something safe to concatenate into an object key.
 *
 * Two jobs, and the second is the load-bearing one. Spaces become underscores so the key matches
 * what the pipeline's own upload path produces. And every path segment is discarded, because the
 * filename arrives from a browser and is concatenated into a key: `../` in a name is how an upload
 * lands on `knowledge-base/playbooks/`, a Terraform-managed prefix where it would be silently
 * overwritten at the next apply, or worse, overwrite a seed document until then.
 *
 * @param filename - the untrusted name from the client.
 * @returns the sanitized base name.
 * @throws Error when nothing usable remains -- an empty key is not a thing to guess a name for.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const cleaned = base.trim().replace(/\s+/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(
      `filename "${filename}" has no usable name after sanitizing`,
    );
  }
  return cleaned;
}

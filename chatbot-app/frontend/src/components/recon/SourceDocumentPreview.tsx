"use client";

import { useEffect, useState } from "react";
import { reconFetch } from "@/lib/recon-auth";

// The source file behind a processed document, rendered in place.
//
// The bytes are fetched with the recon BFF's Authorization header and handed to the element as an object
// URL, for the same reason `AuthedImage` does it: `src/proxy.ts` gates `/api/recon/*`, and neither
// `<iframe src>` nor `<img src>` can carry a header, so pointing either straight at the route returns
// 401. Exempting the route from the gate would leave raw customer financial documents as the one open
// door in the BFF.
//
// What the blob's own `type` decides is which element to use. It comes from the response's Content-Type,
// which the route takes from S3 rather than from the caller — so an `.xlsx` cannot talk its way into an
// `<iframe>` that would render it as a blank frame.

/** How to show a given content type: in a frame, as an image, or not at all. */
function renderKindFor(contentType: string): "frame" | "image" | "download" {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/pdf" || type.startsWith("text/")) return "frame";
  if (type.startsWith("image/")) return "image";
  return "download";
}

/**
 * A live view of one document's source file.
 *
 * @param objectKey - the pipeline's object key; encoded into the source route's single dynamic segment.
 * @param className - Tailwind classes for the wrapper.
 */
export default function SourceDocumentPreview({
  objectKey,
  className = "",
}: {
  objectKey: string;
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `cancelled` guards against a fast key change resolving out of order and against setting state
    // after unmount; the object URL is revoked on cleanup so the blob is not leaked.
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    setContentType("");
    setError(null);

    (async () => {
      try {
        const resp = await reconFetch(
          `/api/recon/idp-documents/${encodeURIComponent(objectKey)}/source`,
        );
        if (!resp.ok) {
          // The route answers in plain text and every one of its refusals names the key or the missing
          // configuration. Surfacing that verbatim is the difference between "preview unavailable" and
          // "the object is no longer in the input bucket".
          throw new Error(
            (await resp.text()).trim() || `request failed: ${resp.status}`,
          );
        }
        const blob = await resp.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setContentType(blob.type);
        setObjectUrl(created);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [objectKey]);

  const filename = objectKey.split("/").pop() || objectKey;

  if (error) {
    return (
      <div
        className={`rc-mono flex min-h-[240px] items-center justify-center border border-dashed border-[var(--rc-line)] p-6 text-center text-[12px] ${className}`}
        style={{ color: "var(--rc-amber)" }}
      >
        Source document unavailable — {error}
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        className={`rc-mono flex min-h-[240px] items-center justify-center border border-dashed border-[var(--rc-line)] p-6 text-[12px] text-[var(--rc-cyan)] ${className}`}
      >
        ◆ reading the source document…
      </div>
    );
  }

  const kind = renderKindFor(contentType);

  return (
    <div className={`space-y-2 ${className}`}>
      {kind === "frame" && (
        <iframe
          src={objectUrl}
          title={`Source document ${filename}`}
          className="h-[520px] w-full border border-[var(--rc-line)] bg-white"
        />
      )}
      {kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={objectUrl}
          alt={`Source document ${filename}`}
          className="max-h-[520px] w-full border border-[var(--rc-line)] bg-white object-contain"
        />
      )}
      {kind === "download" && (
        <div className="rc-mono flex min-h-[240px] flex-col items-center justify-center gap-3 border border-dashed border-[var(--rc-line)] p-6 text-center text-[12px] text-[var(--rc-ink-faint)]">
          <span>
            {contentType || "this file type"} cannot be shown in the browser.
          </span>
          <a
            href={objectUrl}
            download={filename}
            className="rc-mono border border-[var(--rc-line)] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] transition-colors hover:border-[var(--rc-cyan)] hover:text-[var(--rc-ink)]"
          >
            Download {filename}
          </a>
        </div>
      )}
      {/* An object URL, so this opens the bytes already in the page rather than issuing a second
          unauthenticated request that the proxy would refuse. */}
      <a
        href={objectUrl}
        target="_blank"
        rel="noreferrer"
        className="rc-mono block text-[11px] text-[var(--rc-ink-faint)] underline hover:text-[var(--rc-ink)]"
      >
        Open {filename} in a new tab ↗
      </a>
    </div>
  );
}

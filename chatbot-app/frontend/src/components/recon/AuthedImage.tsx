"use client";

import { useEffect, useState } from "react";
import { reconFetch } from "@/lib/recon-auth";

/**
 * An `<img>` whose source is fetched with the recon BFF's Authorization header.
 *
 * A plain `<img src="/api/recon/page-image?...">` cannot carry a header, and `src/proxy.ts` gates
 * every `/api/recon/*` request, so such an element 401s on every preview. The alternative —
 * exempting page-image from the gate — would leave the most sensitive endpoint in the BFF (raw
 * pages of customer financial documents) as the one open door, so instead fetch the bytes with the
 * token and hand the element an object URL.
 *
 * @param src same-origin `/api/recon/...` URL returning image bytes.
 * @param alt accessible description, forwarded to the `<img>`.
 * @param className Tailwind classes, forwarded to the `<img>`.
 */
export default function AuthedImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // `cancelled` guards against a fast src change resolving out of order and against setting
    // state after unmount; the object URL is revoked on cleanup so the blob is not leaked.
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    setFailed(false);

    (async () => {
      try {
        const resp = await reconFetch(src);
        if (!resp.ok) throw new Error(`image fetch failed: ${resp.status}`);
        const blob = await resp.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch (error) {
        console.warn("[AuthedImage]", src, error);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src]);

  if (failed) {
    return (
      <div
        className={className}
        title={alt}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "3rem",
          color: "var(--rc-ink-faint)",
          fontSize: 11,
        }}
      >
        preview unavailable
      </div>
    );
  }
  if (!objectUrl) {
    // Reserve the layout box while the bytes load so the panel does not jump.
    return <div className={className} style={{ minHeight: "3rem" }} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={objectUrl} alt={alt} className={className} />;
}

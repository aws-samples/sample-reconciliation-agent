"use client";

import { useState } from "react";
import type { IdpDetail } from "@/lib/reconApi";
import AuthedImage from "@/components/recon/AuthedImage";
import { Eyebrow, Panel } from "@/components/recon/ui";

// Renders the IDP document processing results embedded on the recon item: per-section
// classification and the extracted key-value fields — mirroring the IDP Visual Document
// Editor's "Document Data" pane. Page-image previews (idp_pages) are shown as source links,
// since the images live in IDP's output bucket.

function humanizeKey(k: string): string {
  // "MessageOriginatedFrom" -> "Message Originated From"; leave ALLCAPS/short keys alone.
  return k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function FieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--rc-ink-faint)]">—</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="text-[var(--rc-ink-faint)]">—</span>;
    return (
      <div className="space-y-2">
        {value.map((v, i) => (
          <div
            key={i}
            className="rounded border border-[var(--rc-line-soft)] bg-[var(--rc-panel-2)] p-2"
          >
            <FieldValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    return (
      <div className="space-y-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="flex gap-2 text-[12px]">
            <span className="rc-mono text-[var(--rc-ink-faint)]">
              {humanizeKey(k)}:
            </span>
            <span className="text-[var(--rc-ink-dim)]">
              <FieldValue value={v} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  return <span className="text-[var(--rc-ink)]">{String(value)}</span>;
}

export function IdpDocumentPanel({ idp }: { idp: IdpDetail }) {
  const sections = idp.idp_sections ?? [];
  const pages = idp.idp_pages ?? [];
  const [active, setActive] = useState(0);
  const [activePage, setActivePage] = useState(0);

  // Nothing captured from IDP -> render nothing (non-IDP items).
  const hasData =
    sections.length > 0 ||
    (idp.idp_class ?? null) !== null ||
    !!idp.idp_raw_ref;
  if (!hasData) return null;

  const activeSection = sections[active];
  const fields = activeSection?.fields ?? idp.idp_attributes ?? {};
  // Page previews are served same-origin from recon's assets bucket (copied at ingest).
  const allPreviews = pages.filter((p) => p.local_key);

  // Bind the viewer to the ACTIVE SECTION's pages: split_document.page_indices is 0-based
  // (index N -> page_id N+1); the event-fallback path stores 1-based PageIds, so if the
  // 0-based mapping matches nothing, retry as direct page ids. No match -> all pages.
  const sectionPreviews = (() => {
    const idx = activeSection?.page_indices ?? [];
    if (idx.length === 0) return allPreviews;
    const zeroBased = allPreviews.filter((p) =>
      idx.includes(Number(p.page_id) - 1),
    );
    if (zeroBased.length > 0) return zeroBased;
    const oneBased = allPreviews.filter((p) => idx.includes(Number(p.page_id)));
    return oneBased.length > 0 ? oneBased : allPreviews;
  })();

  const previews = sectionPreviews;
  const pageSrc = (p: { local_key?: string }) =>
    `/api/recon/page-image?key=${encodeURIComponent(p.local_key ?? "")}`;

  // Selecting a section jumps the viewer to that section's first page.
  const selectSection = (i: number) => {
    setActive(i);
    setActivePage(0);
  };

  return (
    <Panel className="rc-rise p-6" scan>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>IDP Document Processing</Eyebrow>
        <div className="flex items-center gap-3 rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          {idp.idp_page_count != null && (
            <span>{idp.idp_page_count} pages</span>
          )}
          {idp.idp_workflow_status && <span>· {idp.idp_workflow_status}</span>}
          {idp.idp_execution_arn && (
            <span
              title={`IDP extraction run id (Step Functions execution). A reprocess in IDP produces a new run id and re-drives this case with the fresh extraction: ${idp.idp_execution_arn}`}
            >
              · run {idp.idp_execution_arn.split(":").pop()?.slice(0, 8)}
            </span>
          )}
          {idp.idp_confidence_alert_count != null && (
            <span
              title="Number of extracted fields below IDP's confidence threshold — 0 means every field extracted cleanly"
              style={{
                color:
                  idp.idp_confidence_alert_count > 0
                    ? "var(--rc-amber)"
                    : "var(--rc-green)",
              }}
            >
              ·{" "}
              {idp.idp_confidence_alert_count === 0
                ? "no low-confidence fields"
                : `${idp.idp_confidence_alert_count} low-confidence field${idp.idp_confidence_alert_count === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
      </div>

      {/* Section tabs (classification per section, like the IDP editor's section list). */}
      {sections.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1">
          {sections.map((s, i) => (
            <button
              key={s.section_id}
              onClick={() => selectSection(i)}
              className="rc-mono rounded px-3 py-1 text-[11px] tracking-[0.04em]"
              style={{
                color: i === active ? "var(--rc-ink)" : "var(--rc-ink-faint)",
                background: i === active ? "var(--rc-panel-2)" : "transparent",
                border:
                  i === active
                    ? "1px solid var(--rc-cyan)"
                    : "1px solid var(--rc-line)",
              }}
            >
              §{s.section_id} · {s.classification ?? "—"}
            </button>
          ))}
        </div>
      )}

      {/* Split view (like the IDP Visual Document Editor): source page image on the left,
          extracted field values on the right. */}
      <div
        className={`mt-5 grid grid-cols-1 gap-6 border-t border-[var(--rc-line-soft)] pt-4 ${
          previews.length > 0 ? "lg:grid-cols-[0.9fr_1.1fr]" : ""
        }`}
      >
        {previews.length > 0 &&
          (() => {
            // Clamp in case the section switch shrank the preview list.
            const shown = previews[Math.min(activePage, previews.length - 1)];
            return (
              <div>
                <div className="rc-eyebrow mb-2">
                  {activeSection
                    ? `§${activeSection.section_id} · ${activeSection.classification ?? "—"} — `
                    : ""}
                  page {shown?.page_id}
                  {previews.length > 1
                    ? ` (${previews.length} in section)`
                    : ""}
                </div>
                <AuthedImage
                  src={pageSrc(shown)}
                  alt={`Document page ${shown?.page_id}`}
                  className="w-full rounded border border-[var(--rc-line)] bg-white"
                />
                {previews.length > 1 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {previews.map((p, i) => (
                      <button
                        key={p.page_id}
                        onClick={() => setActivePage(i)}
                        className="overflow-hidden rounded border"
                        style={{
                          borderColor:
                            i === activePage
                              ? "var(--rc-cyan)"
                              : "var(--rc-line)",
                        }}
                        title={`Page ${p.page_id}`}
                      >
                        <AuthedImage
                          src={pageSrc(p)}
                          alt={`Page ${p.page_id} thumbnail`}
                          className="h-24 w-auto bg-white"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

        {/* Extracted field values for the active section. */}
        <div className="space-y-3">
          {Object.keys(fields).length === 0 ? (
            <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
              No extracted fields captured.
            </p>
          ) : (
            <dl className="space-y-3">
              {Object.entries(fields).map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[minmax(140px,0.4fr)_1fr] gap-3"
                >
                  <dt className="rc-mono text-[12px] uppercase tracking-[0.06em] text-[var(--rc-ink-faint)]">
                    {humanizeKey(k)}
                  </dt>
                  <dd className="text-[13px]">
                    <FieldValue value={v} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>

      {/* Items ingested before preview-copying have no local images — show refs only. */}
      {previews.length === 0 && pages.length > 0 && (
        <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
          <div className="rc-eyebrow mb-2">Source pages ({pages.length})</div>
          <div className="flex flex-wrap gap-2">
            {pages.map((p) => (
              <span
                key={p.page_id}
                title={p.image_uri}
                className="rc-mono rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-2 py-1 text-[11px] text-[var(--rc-ink-faint)]"
              >
                page {p.page_id}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

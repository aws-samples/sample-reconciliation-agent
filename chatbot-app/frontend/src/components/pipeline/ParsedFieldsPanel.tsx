"use client";

import { useState } from "react";
import Link from "next/link";
import type { EmailRecord, FieldEvidence, OmsFieldDef } from "@/lib/pipeline/types";
import { fieldsBySection } from "@/lib/pipeline/omsSchema";
import { formatDuration } from "@/components/pipeline/format";
import {
  BTN_LINK,
  BTN_PRIMARY,
  BTN_QUIET,
  Disclosure,
  Eyebrow,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";
import { ConfidenceChip, StatusPill } from "@/components/pipeline/ui";

// What the parsing agent made of the email, beside the email itself. Every value is shown with the
// text it came from and the rule that shaped it, because "the parser said S+275 means 2.750%" is
// only reviewable when the reviewer can see the line that said S+275 and the skill that said how to
// convert it.

/** A small labelled chip, for skills, memory hits and enriched fields. */
function Chip({ children, title }: { children: string; title?: string }) {
  return (
    <span
      className="rc-mono rounded border border-[var(--rc-line)] px-2 py-0.5 text-[10.5px] text-[var(--rc-ink-dim)]"
      title={title}
    >
      {children}
    </span>
  );
}

/** The parsed value with the evidence behind it as a disclosure body. */
function EvidenceBody({ evidence }: { evidence: FieldEvidence }) {
  return (
    <div className="space-y-2 p-3">
      {evidence.excerpt ? (
        <blockquote className="rc-mono whitespace-pre-wrap border-l-2 border-[var(--rc-cyan)] pl-3 text-[11.5px] leading-relaxed text-[var(--rc-ink-dim)]">
          {evidence.excerpt}
        </blockquote>
      ) : (
        <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          no excerpt — the value was inferred rather than read
        </p>
      )}
      {evidence.rule && (
        <p className="text-[12px] leading-relaxed text-[var(--rc-ink)]">
          <span className="rc-eyebrow mr-2">rule</span>
          {evidence.rule}
        </p>
      )}
    </div>
  );
}

/** One parsed field: label, value, confidence; opens to the excerpt and rule when there is evidence. */
function FieldRow({
  def,
  value,
  evidence,
}: {
  def: OmsFieldDef;
  value: string;
  evidence: FieldEvidence | undefined;
}) {
  const summary = (
    <span className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-baseline gap-3">
      <span className="rc-mono truncate text-[11px] text-[var(--rc-ink-faint)]" title={def.key}>
        {def.label}
      </span>
      <span
        className="rc-mono break-words text-[12px]"
        style={{ color: value ? "var(--rc-ink)" : "var(--rc-ink-faint)" }}
        data-field={def.key}
      >
        {value || "—"}
      </span>
    </span>
  );
  if (!evidence)
    return (
      <div className="rounded border border-[var(--rc-line-soft)] px-3 py-2">{summary}</div>
    );
  return (
    <Disclosure summary={summary} meta={<ConfidenceChip level={evidence.confidence} />}>
      <EvidenceBody evidence={evidence} />
    </Disclosure>
  );
}

export function ParsedFieldsPanel({
  email,
  onReparse,
  reparsing = false,
}: {
  email: EmailRecord;
  onReparse?: () => void;
  reparsing?: boolean;
}) {
  // Blank fields hidden by default: the schema has seventy columns and most of an email fills
  // twenty. The count of what is hidden is shown, so "hidden" never reads as "missing".
  const [showBlank, setShowBlank] = useState(false);
  const parse = email.parse;
  const inFlight = email.status === "RECEIVED" || email.status === "PARSING";

  return (
    <Panel className="rc-rise p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Eyebrow>Parsed · agent output</Eyebrow>
          <StatusPill status={email.status} />
        </div>
        <div className="flex items-center gap-2">
          {email.deal_id && (
            <Link href={`/pipeline/deals/${encodeURIComponent(email.deal_id)}`} className={BTN_PRIMARY}>
              Open deal →
            </Link>
          )}
          {onReparse && (
            <button
              type="button"
              onClick={onReparse}
              disabled={reparsing || inFlight}
              className={BTN_QUIET}
              title="Run the parser again with the current skills and memory"
            >
              {reparsing ? "Re-parsing…" : "Re-parse"}
            </button>
          )}
        </div>
      </div>

      {inFlight ? (
        <div className="mt-4">
          <Placeholder kind="loading">
            ◆ {email.status === "RECEIVED" ? "queued for the parser…" : "the parsing agent is reading the email…"}
          </Placeholder>
        </div>
      ) : email.status === "PARSE_FAILED" ? (
        <div className="mt-4">
          <Placeholder kind="error">Parse failed — {email.error ?? "no reason recorded"}</Placeholder>
        </div>
      ) : !parse ? (
        <div className="mt-4">
          <Placeholder kind="empty">◇ parsed, but no output was stored</Placeholder>
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          {/* Run metadata: which model, how long, which skills and memories shaped the result. */}
          <dl className="rc-mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
            <dt className="rc-eyebrow pt-0.5">Model</dt>
            <dd className="break-all text-[var(--rc-ink)]">{parse.model_id || "—"}</dd>
            <dt className="rc-eyebrow pt-0.5">Duration</dt>
            <dd className="text-[var(--rc-ink)]">{formatDuration(parse.duration_ms)}</dd>
            <dt className="rc-eyebrow pt-0.5">Skills</dt>
            <dd className="flex flex-wrap gap-1.5">
              {parse.skills_used.length === 0 ? (
                <span className="text-[var(--rc-ink-faint)]">none loaded</span>
              ) : (
                parse.skills_used.map((s) => <Chip key={s}>{s}</Chip>)
              )}
            </dd>
            <dt className="rc-eyebrow pt-0.5">Memory</dt>
            <dd className="flex flex-wrap gap-1.5" data-testid="memory-hits">
              {parse.memory_hits.length === 0 ? (
                <span className="text-[var(--rc-ink-faint)]">no relevant memories recalled</span>
              ) : (
                parse.memory_hits.map((m, i) => (
                  <Chip key={m.record_id ?? i} title={m.text}>
                    {m.text.length > 72 ? `${m.text.slice(0, 72)}…` : m.text}
                  </Chip>
                ))
              )}
            </dd>
            <dt className="rc-eyebrow pt-0.5">Enrichment</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {parse.enrichment.issuer_match ? (
                <>
                  <span className="text-[var(--rc-ink)]">
                    security master → {parse.enrichment.issuer_match}
                  </span>
                  {parse.enrichment.fields_from_security_master.map((k) => (
                    <Chip key={k} title="filled from the security master">
                      {k}
                    </Chip>
                  ))}
                </>
              ) : (
                <span className="text-[var(--rc-ink-faint)]">no issuer match in the security master</span>
              )}
            </dd>
          </dl>

          {/* The fields, by OMS section. */}
          <div className="space-y-4">
            {fieldsBySection().map(({ section, fields }) => {
              const rows = fields.filter(
                (f) => showBlank || (parse.fields[f.key] ?? "") !== "" || parse.evidence[f.key],
              );
              const hidden = fields.length - rows.length;
              if (rows.length === 0 && !showBlank) return null;
              return (
                <section key={section}>
                  <div className="flex items-baseline justify-between">
                    <Eyebrow>{section}</Eyebrow>
                    {hidden > 0 && (
                      <span className="rc-mono text-[10.5px] text-[var(--rc-ink-faint)]">
                        {hidden} blank hidden
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {rows.map((f) => (
                      <FieldRow
                        key={f.key}
                        def={f}
                        value={parse.fields[f.key] ?? ""}
                        evidence={parse.evidence[f.key]}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            <button type="button" onClick={() => setShowBlank((v) => !v)} className={BTN_LINK}>
              {showBlank ? "Hide blank fields" : "Show blank fields"}
            </button>
          </div>

          {/* What the agent decided without direct evidence — the list a reviewer reads first. */}
          <section>
            <Eyebrow>Assumptions</Eyebrow>
            {parse.assumptions.length === 0 ? (
              <p className="rc-mono mt-2 text-[12px] text-[var(--rc-ink-faint)]">
                ◇ none recorded
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {parse.assumptions.map((a, i) => (
                  <li
                    key={i}
                    className="border-l-2 border-[var(--rc-amber)] pl-3 text-[12.5px] leading-relaxed text-[var(--rc-ink)]"
                  >
                    {a}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

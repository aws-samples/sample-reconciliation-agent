"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { decideProposal, listProposals } from "@/lib/pipelineApi";
import type { ProposalStatus, SkillProposal } from "@/lib/pipeline/types";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import { LineDiff } from "@/components/pipeline/LineDiff";
import { formatDateTime } from "@/components/pipeline/format";
import {
  BTN_CONFIRM,
  BTN_DANGER,
  Disclosure,
  Eyebrow,
  Notice,
  Panel,
  Placeholder,
  type ActionOutcome,
} from "@/components/app-ui/ui";
import { StatusPill } from "@/components/pipeline/ui";

// Where the assistant's skill changes wait for a person. Nothing the assistant proposes reaches S3
// until it is approved here, and the diff is the whole point of the page: a summary says what the
// change is for, the diff says what it actually does.

const FILTERS: ("ALL" | ProposalStatus)[] = ["PENDING", "APPROVED", "REJECTED", "ALL"];

export default function ProposalsPage() {
  const { isAdmin } = usePipelineSubject();
  const [proposals, setProposals] = useState<SkillProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("PENDING");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Carries its tone: a refused approve must not read like "Approved — … now holds the proposed content".
  const [msg, setMsg] = useState<ActionOutcome | null>(null);

  const load = () =>
    listProposals()
      .then((p) =>
        setProposals([...p].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))),
      )
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(
    () => (proposals ?? []).filter((p) => filter === "ALL" || p.status === filter),
    [proposals, filter],
  );
  const selected = proposals?.find((p) => p.proposal_id === selectedId) ?? null;

  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(decision);
    setMsg(null);
    try {
      const next = await decideProposal(id, decision);
      setProposals((prev) => (prev ?? []).map((p) => (p.proposal_id === id ? next : p)));
      setMsg({
        tone: "success",
        text:
          decision === "approve"
            ? `Approved — skills/${next.skill_name}/SKILL.md now holds the proposed content; the parser uses it on its next run.`
            : "Rejected — the skill is unchanged.",
      });
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/pipeline/skills"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          ← Skills
        </Link>
      </div>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Proposed skill changes · reviewed before they apply</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            Proposals
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className="rc-mono rounded px-3 py-1 text-[11px] tracking-[0.06em]"
              style={{
                color: f === filter ? "var(--rc-ink)" : "var(--rc-ink-faint)",
                background: f === filter ? "var(--rc-panel-2)" : "transparent",
                border: f === filter ? "1px solid var(--rc-cyan)" : "1px solid var(--rc-line)",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {error ? (
        <Placeholder kind="error">Failed to load proposals — {error}</Placeholder>
      ) : !proposals ? (
        <Placeholder kind="loading">◆ loading proposals…</Placeholder>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          {shown.length === 0 ? (
            <Placeholder kind="empty">
              {filter === "PENDING"
                ? "◇ nothing waiting for review"
                : "◇ no proposals in this status"}
            </Placeholder>
          ) : (
            <Panel className="rc-rise overflow-hidden">
              {shown.map((p) => {
                const on = p.proposal_id === selectedId;
                return (
                  <button
                    key={p.proposal_id}
                    type="button"
                    onClick={() => setSelectedId(p.proposal_id)}
                    aria-pressed={on}
                    className="rc-row block w-full border-b border-[var(--rc-line-soft)] px-5 py-4 text-left last:border-0"
                    style={{ background: on ? "var(--rc-panel-2)" : undefined }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="rc-mono text-[12px] text-[var(--rc-cyan)]">{p.skill_name}</span>
                      <StatusPill status={p.status} />
                    </div>
                    <p className="mt-1.5 text-[13px] leading-snug text-[var(--rc-ink)]">{p.summary}</p>
                    <p className="rc-mono mt-1 text-[10.5px] text-[var(--rc-ink-faint)]">
                      {p.source.kind === "assistant" ? "proposed by the assistant" : "proposed by hand"} ·{" "}
                      {formatDateTime(p.created_at)}
                    </p>
                  </button>
                );
              })}
            </Panel>
          )}

          {selected ? (
            <Panel className="rc-rise space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Eyebrow>Proposal · {selected.skill_name}</Eyebrow>
                  <h2 className="mt-1 text-[16px] font-medium leading-snug text-[var(--rc-ink)]">
                    {selected.summary}
                  </h2>
                </div>
                <StatusPill status={selected.status} />
              </div>

              <div>
                <Eyebrow>Rationale</Eyebrow>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--rc-ink)]">
                  {selected.rationale || "—"}
                </p>
              </div>

              <dl className="rc-mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11.5px]">
                <dt className="rc-eyebrow pt-0.5">Source</dt>
                <dd className="text-[var(--rc-ink-dim)]">
                  {selected.source.kind}
                  {selected.source.deal_id && (
                    <>
                      {" · "}
                      <Link
                        href={`/pipeline/deals/${encodeURIComponent(selected.source.deal_id)}`}
                        className="text-[var(--rc-cyan)] hover:underline"
                      >
                        deal {selected.source.deal_id}
                      </Link>
                    </>
                  )}
                  {selected.source.session_id && ` · session ${selected.source.session_id}`}
                </dd>
                <dt className="rc-eyebrow pt-0.5">Created</dt>
                <dd className="text-[var(--rc-ink-dim)]">{formatDateTime(selected.created_at)}</dd>
                {selected.decided_at && (
                  <>
                    <dt className="rc-eyebrow pt-0.5">Decided</dt>
                    <dd className="text-[var(--rc-ink-dim)]">
                      {formatDateTime(selected.decided_at)}
                      {selected.decided_by ? ` by ${selected.decided_by}` : ""}
                    </dd>
                  </>
                )}
              </dl>

              <div>
                <Eyebrow>Change · current → proposed</Eyebrow>
                <div className="mt-2">
                  <LineDiff before={selected.current_content} after={selected.proposed_content} />
                </div>
              </div>

              <Disclosure
                summary={<span className="rc-mono text-[12px] text-[var(--rc-ink)]">Proposed content in full</span>}
                meta={`${selected.proposed_content.split("\n").length} lines`}
              >
                <pre className="rc-mono max-h-[420px] overflow-auto whitespace-pre-wrap p-4 text-[12px] leading-relaxed text-[var(--rc-ink)]">
                  {selected.proposed_content}
                </pre>
              </Disclosure>

              {selected.status === "PENDING" &&
                (isAdmin ? (
                  <div className="flex items-center gap-3 border-t border-[var(--rc-line)] pt-4">
                    <button
                      type="button"
                      onClick={() => decide(selected.proposal_id, "approve")}
                      disabled={busy !== null}
                      className={BTN_CONFIRM}
                      title="Write the proposed content to the skill in S3"
                    >
                      {busy === "approve" ? "Applying…" : "Approve & apply"}
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(selected.proposal_id, "reject")}
                      disabled={busy !== null}
                      className={BTN_DANGER}
                    >
                      {busy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                  </div>
                ) : (
                  <p className="rc-mono border-t border-[var(--rc-line)] pt-4 text-[11.5px] text-[var(--rc-ink-faint)]">
                    Approving or rejecting requires membership of the admin group.
                  </p>
                ))}
            </Panel>
          ) : (
            <Placeholder kind="empty">◇ select a proposal to see its rationale and diff</Placeholder>
          )}
        </div>
      )}
    </div>
  );
}

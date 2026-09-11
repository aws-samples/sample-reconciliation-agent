"use client";

import { Fragment, type ReactNode } from "react";

// Enough markdown to read an assistant reply, and no more: paragraphs, bulleted and numbered lists,
// fenced code blocks, inline code and bold. No external renderer, because the console must not pull
// a markdown-to-HTML pipeline (and its raw-HTML surface) into a page whose text comes from a model.
// Everything here renders as React elements from plain strings, so nothing in a reply is ever
// interpreted as markup.

type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "pre"; text: string };

/**
 * Group lines into blocks.
 *
 * A fenced block swallows everything to its closing fence, list items collect until a non-item line,
 * and consecutive plain lines join into one paragraph. Blank lines separate blocks.
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ kind: "pre", text: code.join("\n") });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      const last = blocks[blocks.length - 1];
      const text = (bullet ?? numbered)![1];
      if (last && last.kind === kind) last.items.push(text);
      else blocks.push({ kind, items: [text] });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    // A plain line directly under a list item continues that item (soft wrap) rather than starting a
    // paragraph — models wrap long bullets, and a paragraph per wrapped tail reads as a list that fell
    // apart.
    const last = blocks[blocks.length - 1];
    if (para.length === 0 && last && (last.kind === "ul" || last.kind === "ol")) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/**
 * Inline code and bold within one run of text.
 *
 * Split on the two delimiters in one pass so a backtick span containing asterisks is still code and
 * a bold span containing backticks is still bold-then-code, in source order.
 */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={key++}>{m[1].slice(1, -1)}</code>);
    else out.push(<strong key={key++}>{m[2].slice(2, -2)}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A model reply rendered as readable blocks. */
export function MarkdownLite({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="dp-prose text-[13px] leading-relaxed text-[var(--dp-ink)]">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "pre":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </Tag>
            );
          }
          default:
            return (
              <p key={i}>
                {renderInline(b.text).map((node, j) => (
                  <Fragment key={j}>{node}</Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

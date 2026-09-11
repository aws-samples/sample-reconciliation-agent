import type { ReactNode } from "react";
import { Chivo, IBM_Plex_Mono } from "next/font/google";
import "./pipeline-theme.css";
import { PipelineNav } from "@/components/pipeline/nav";
import { UserMenu } from "@/components/pipeline/UserMenu";

// Distinctive type pairing for the instrument aesthetic: Chivo (condensed, technical display)
// + IBM Plex Mono (numerics, labels, data). Deliberately not the generic Inter/Roboto set.
const chivo = Chivo({
  subsets: ["latin"],
  weight: ["500", "700", "900"],
  variable: "--font-chivo",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

export default function PipelineLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`pipeline-root ${chivo.variable} ${plexMono.variable}`}>
      <header className="sticky top-0 z-10 border-b border-[var(--dp-line)] bg-[var(--dp-bg)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-10 px-6 py-4">
          <a href="/pipeline/inbox" className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-[2px]"
              style={{
                background: "var(--dp-cyan)",
                boxShadow: "0 0 12px 0 var(--dp-cyan)",
              }}
            />
            <span className="dp-display text-[18px] font-black text-[var(--dp-ink)]">
              Deal<span className="text-[var(--dp-cyan)]">·</span>Pipeline
            </span>
          </a>
          <PipelineNav />
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}

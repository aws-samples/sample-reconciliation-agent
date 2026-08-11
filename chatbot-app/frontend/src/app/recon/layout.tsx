import type { ReactNode } from "react";
import { Chivo, IBM_Plex_Mono } from "next/font/google";
import "./recon-theme.css";
import { ReconNav } from "@/components/recon/nav";
import { UserMenu } from "@/components/recon/UserMenu";

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

export default function ReconLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`recon-root ${chivo.variable} ${plexMono.variable}`}>
      <header className="sticky top-0 z-10 border-b border-[var(--rc-line)] bg-[var(--rc-bg)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-10 px-6 py-4">
          <a href="/recon/dashboard" className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-[2px]"
              style={{
                background: "var(--rc-cyan)",
                boxShadow: "0 0 12px 0 var(--rc-cyan)",
              }}
            />
            <span className="rc-display text-[18px] font-black text-[var(--rc-ink)]">
              Recon<span className="text-[var(--rc-cyan)]">·</span>Ops
            </span>
          </a>
          <ReconNav />
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}

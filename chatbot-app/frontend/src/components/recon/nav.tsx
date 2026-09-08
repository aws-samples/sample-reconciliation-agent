"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useReconSubject } from "@/hooks/useReconSubject";

// `adminOnly` hides a link from anyone outside the admin group. It is presentation only — the routes
// behind Config re-check the group against the presented token, so a hidden link is a courtesy to people
// who cannot use the page, not the thing that stops them.
const LINKS = [
  { href: "/recon/dashboard", label: "Dashboard" },
  { href: "/recon/queue", label: "Queue" },
  { href: "/recon/skills", label: "Skills" },
  { href: "/recon/lessons", label: "Lessons" },
  { href: "/recon/evals", label: "Evals" },
  { href: "/recon/idp-documents", label: "Documents" },
  { href: "/recon/config", label: "Config", adminOnly: true },
];

export function ReconNav() {
  const pathname = usePathname();
  const { isAdmin } = useReconSubject();
  // Hidden until the identity resolves, rather than shown and then withdrawn: a tab that appears for a
  // moment and vanishes reads as a bug, and clicking it in that window would land on a 403.
  const links = LINKS.filter((l) => !l.adminOnly || isAdmin);
  return (
    <nav className="flex items-center gap-1">
      {links.map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            className="rc-mono relative px-3 py-1.5 text-[12px] uppercase tracking-[0.14em] transition-colors"
            style={{ color: active ? "var(--rc-ink)" : "var(--rc-ink-faint)" }}
          >
            {l.label}
            {active && (
              <span
                className="absolute inset-x-2 -bottom-[17px] h-[2px]"
                style={{
                  background: "var(--rc-cyan)",
                  boxShadow: "0 0 8px var(--rc-cyan)",
                }}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

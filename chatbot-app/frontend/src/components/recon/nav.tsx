"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/recon/dashboard", label: "Dashboard" },
  { href: "/recon/queue", label: "Queue" },
  { href: "/recon/skills", label: "Skills" },
  { href: "/recon/lessons", label: "Lessons" },
  { href: "/recon/evals", label: "Evals" },
  { href: "/recon/config", label: "Config" },
];

export function ReconNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((l) => {
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

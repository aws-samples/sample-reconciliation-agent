"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useAppSubject } from "@/hooks/useAppSubject";
import type { AppId } from "@/lib/auth/apps";

/** One tab in an app's header. */
export interface AppNavLink {
  href: string;
  label: string;
  /**
   * Hide the link from anyone outside the app's admin group. Presentation only — the routes behind an
   * admin-only tab re-check the group against the presented token, so a hidden link is a courtesy to
   * people who cannot use the page, not the thing that stops them.
   */
  adminOnly?: boolean;
}

export function AppNav({
  appId,
  links,
}: {
  appId: AppId;
  links: readonly AppNavLink[];
}) {
  const pathname = usePathname();
  const { isAdmin } = useAppSubject(appId);
  // Hidden until the identity resolves, rather than shown and then withdrawn: a tab that appears for a
  // moment and vanishes reads as a bug, and clicking it in that window would land on a 403.
  const shown = links.filter((l) => !l.adminOnly || isAdmin);
  return (
    <nav className="flex items-center gap-1">
      {shown.map((l) => {
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

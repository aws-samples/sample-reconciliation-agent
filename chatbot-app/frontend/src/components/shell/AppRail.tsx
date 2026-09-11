"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Layers,
  LogOut,
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
  Scale,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { signOut } from "@/components/AuthWrapper";
import { APPS, type AppDefinition, type AppId, type Viewer } from "@/lib/auth/apps";
import { readRailCollapsed, writeRailCollapsed } from "@/lib/shell/railState";
import { cn } from "@/lib/utils";

// The vertical app rail: the one piece of navigation that belongs to the console rather than to an
// application. It lists the apps the viewer may open, marks the one they are in, and carries the identity
// footer and sign-out that used to live in each app's own header (those stay where they are; the rail is
// additive so neither app's layout had to change).
//
// Deliberately neutral. Each app themes itself under `.recon-root` / `.pipeline-root`; the rail uses the
// `--shell-*` variables from globals.css only, so it reads the same whichever app is open.

/** Icon per application. Registered here, not in apps.ts, so the registry stays free of React. */
export const APP_ICONS: Record<AppId, LucideIcon> = {
  recon: Scale,
  pipeline: Mail,
};

/** Rail widths. The content column is `flex-1`, so these are the only two numbers the layout needs. */
const EXPANDED_CLASS = "w-[220px]";
const COLLAPSED_CLASS = "w-14";

export interface AppRailProps {
  /** The viewer once known; `null` while loading or after `/api/me` failed. */
  viewer: Viewer | null;
  loading: boolean;
  /** The app whose page tree the current path belongs to, for highlighting and the admin chip. */
  currentApp: AppDefinition | undefined;
}

/**
 * Collapsed state, persisted.
 *
 * Read in an effect rather than in the initial state: the server has no storage, so initialising from it
 * would make the first client render disagree with the HTML it hydrates. One expanded frame on a browser
 * that prefers collapsed is the cheaper defect.
 */
function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(readRailCollapsed());
  }, []);
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeRailCollapsed(next);
      return next;
    });
  };
  return [collapsed, toggle];
}

/** Placeholder rows while the viewer loads: the rail keeps its width and never pops in from empty. */
function RailSkeleton({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex flex-col gap-2 px-2 pt-2" data-testid="app-rail-skeleton" aria-busy="true">
      {[0, 1].map((i) => (
        <div
          key={i}
          className={cn(
            "h-9 animate-pulse rounded-md bg-[var(--shell-panel)]",
            collapsed ? "w-10" : "w-full",
          )}
        />
      ))}
    </div>
  );
}

/** One rail entry. `title` doubles as the tooltip when the label is hidden. */
function RailLink({
  app,
  active,
  collapsed,
}: {
  app: AppDefinition;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = APP_ICONS[app.id];
  return (
    <Link
      href={app.href}
      title={app.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-9 items-center gap-3 rounded-md px-2.5 text-label outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]",
        active
          ? "bg-[var(--shell-accent-soft)] text-[var(--shell-ink)]"
          : "text-[var(--shell-ink-dim)] hover:bg-[var(--shell-panel)] hover:text-[var(--shell-ink)]",
        collapsed && "justify-center px-0",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-[2px] rounded-r bg-[var(--shell-accent)]"
        />
      )}
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{app.label}</span>}
    </Link>
  );
}

export function AppRail({ viewer, loading, currentApp }: AppRailProps) {
  const [collapsed, toggle] = useRailCollapsed();
  const accessible = viewer ? APPS.filter((a) => viewer.apps[a.id]?.access) : [];
  const isAdminHere = Boolean(viewer && currentApp && viewer.apps[currentApp.id]?.admin);
  const subject = viewer?.subject || "";

  return (
    <aside
      aria-label="Console navigation"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "sticky top-0 z-20 flex h-screen shrink-0 flex-col border-r border-[var(--shell-line)]",
        "bg-[var(--shell-bg)] text-[var(--shell-ink)] transition-[width] duration-200",
        collapsed ? COLLAPSED_CLASS : EXPANDED_CLASS,
      )}
    >
      {/* Product mark. Links home so the chooser is always one click away. */}
      <div
        className={cn(
          "flex h-14 items-center border-b border-[var(--shell-line)]",
          collapsed ? "justify-center" : "gap-2.5 px-3",
        )}
      >
        <Link
          href="/"
          title="Agentic Operations Console"
          className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--shell-accent)] text-[var(--shell-bg)]">
            <Layers className="h-4 w-4" aria-hidden="true" />
          </span>
          {!collapsed && (
            <span className="flex flex-col leading-tight">
              <span className="text-label font-semibold">Agentic Ops</span>
              <span className="text-caption text-[var(--shell-ink-dim)]">Console</span>
            </span>
          )}
        </Link>
      </div>

      {/* Applications */}
      <nav aria-label="Applications" className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <RailSkeleton collapsed={collapsed} />
        ) : (
          <ul className="flex flex-col gap-1 px-2">
            {accessible.map((app) => (
              <li key={app.id}>
                <RailLink app={app} active={currentApp?.id === app.id} collapsed={collapsed} />
              </li>
            ))}
            {!viewer && !collapsed && (
              // `/api/me` failed: the shell's banner explains why; here we only say the list is missing
              // rather than showing an empty rail that looks like "you have nothing".
              <li className="px-2.5 py-2 text-caption text-[var(--shell-ink-dim)]">
                Applications unavailable
              </li>
            )}
          </ul>
        )}
      </nav>

      {/* Footer: collapse toggle, identity, sign out */}
      <div className="flex flex-col gap-1 border-t border-[var(--shell-line)] p-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          title={collapsed ? "Expand navigation" : "Collapse navigation"}
          className={cn(
            "flex h-9 items-center gap-3 rounded-md px-2.5 text-label text-[var(--shell-ink-dim)] outline-none transition-colors",
            "hover:bg-[var(--shell-panel)] hover:text-[var(--shell-ink)] focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>

        {!loading && (
          <div
            className={cn(
              "flex items-center gap-2 px-2.5 py-1.5 text-caption text-[var(--shell-ink-dim)]",
              collapsed && "justify-center px-0",
            )}
            title={subject || undefined}
          >
            {collapsed ? (
              // Initial-letter badge; the wrapper's `title` carries the full subject as the tooltip.
              <span
                data-testid="rail-subject-initial"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--shell-panel)] font-mono text-[10px] uppercase text-[var(--shell-ink)]"
              >
                {(subject || "?").slice(0, 1)}
              </span>
            ) : (
              <span className="truncate font-mono text-[var(--shell-ink)]" data-testid="rail-subject">
                {subject || "unknown user"}
              </span>
            )}
            {isAdminHere && (
              <span
                data-testid="admin-chip"
                title="Administrator of this application"
                className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--shell-accent)] px-1.5 py-px text-[10px] uppercase tracking-[0.08em] text-[var(--shell-accent)]"
              >
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                {!collapsed && "admin"}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => void signOut()}
          aria-label="Sign out"
          title="Sign out"
          className={cn(
            "flex h-9 items-center gap-3 rounded-md px-2.5 text-label text-[var(--shell-ink-dim)] outline-none transition-colors",
            "hover:bg-[var(--shell-panel)] hover:text-[var(--shell-ink)] focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]",
            collapsed && "justify-center px-0",
          )}
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!collapsed && <span>Sign out</span>}
        </button>
      </div>
    </aside>
  );
}

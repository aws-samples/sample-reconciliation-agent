import type { ReactNode } from "react";
import { Chivo, IBM_Plex_Mono } from "next/font/google";
import "../../app/app-theme.css";
import type { AppId } from "@/lib/auth/apps";
import { AppNav, type AppNavLink } from "./AppNav";
import { UserMenu } from "./UserMenu";

// The frame every app renders inside: the shared instrument theme and its type pairing, a sticky
// header carrying the app's wordmark, its tabs and the identity chip, and the content column. Each
// app's layout is one call to this with its own id, home, wordmark and links; nothing else in the
// chrome is per-app. `data-app` on the root is the hook `app-theme.css` names for a per-app accent
// override, should one ever be wanted.
//
// Distinctive type pairing for the instrument aesthetic: Chivo (condensed, technical display)
// + IBM Plex Mono (numerics, labels, data). Deliberately not the generic Inter/Roboto set. Loaded
// once here rather than once per app: `next/font` fetches at build time and serves from
// /_next/static, and every app wants the same two families under the same two CSS variables.
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

export interface AppChromeProps {
  appId: AppId;
  /** Where the wordmark links. */
  homeHref: string;
  /** The wordmark, drawn as `left·right` with the dot in the accent colour. */
  brand: { left: string; right: string };
  links: readonly AppNavLink[];
  children: ReactNode;
}

export function AppChrome({ appId, homeHref, brand, links, children }: AppChromeProps) {
  return (
    <div className={`app-root ${chivo.variable} ${plexMono.variable}`} data-app={appId}>
      <header className="sticky top-0 z-10 border-b border-[var(--rc-line)] bg-[var(--rc-bg)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-10 px-6 py-4">
          <a href={homeHref} className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-[2px]"
              style={{
                background: "var(--rc-cyan)",
                boxShadow: "0 0 12px 0 var(--rc-cyan)",
              }}
            />
            <span className="rc-display text-[18px] font-black text-[var(--rc-ink)]">
              {brand.left}
              <span className="text-[var(--rc-cyan)]">·</span>
              {brand.right}
            </span>
          </a>
          <AppNav appId={appId} links={links} />
          <UserMenu appId={appId} />
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}

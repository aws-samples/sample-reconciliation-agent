import type { ReactNode } from "react";
import { AppChrome } from "@/components/app-ui/AppChrome";
import type { AppNavLink } from "@/components/app-ui/AppNav";

// `adminOnly` hides a link from anyone outside the admin group. It is presentation only — the routes
// behind Config re-check the group against the presented token, so a hidden link is a courtesy to people
// who cannot use the page, not the thing that stops them.
const LINKS: readonly AppNavLink[] = [
  { href: "/recon/dashboard", label: "Dashboard" },
  { href: "/recon/queue", label: "Queue" },
  { href: "/recon/skills", label: "Skills" },
  { href: "/recon/lessons", label: "Lessons" },
  { href: "/recon/evals", label: "Evals" },
  { href: "/recon/idp-documents", label: "Documents" },
  { href: "/recon/config", label: "Config", adminOnly: true },
];

export default function ReconLayout({ children }: { children: ReactNode }) {
  return (
    <AppChrome
      appId="recon"
      homeHref="/recon/dashboard"
      brand={{ left: "Recon", right: "Ops" }}
      links={LINKS}
    >
      {children}
    </AppChrome>
  );
}

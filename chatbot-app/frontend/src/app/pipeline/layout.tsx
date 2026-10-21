import type { ReactNode } from "react";
import { AppChrome } from "@/components/app-ui/AppChrome";
import type { AppNavLink } from "@/components/app-ui/AppNav";

// `adminOnly` hides a link from anyone outside the admin group. It is presentation only — the routes
// behind Config re-check the group against the presented token, so a hidden link is a courtesy to people
// who cannot use the page, not the thing that stops them.
const LINKS: readonly AppNavLink[] = [
  { href: "/pipeline/inbox", label: "Inbox" },
  { href: "/pipeline/deals", label: "Deals" },
  { href: "/pipeline/assistant", label: "Assistant" },
  { href: "/pipeline/skills", label: "Skills" },
  { href: "/pipeline/config", label: "Config", adminOnly: true },
];

export default function PipelineLayout({ children }: { children: ReactNode }) {
  return (
    <AppChrome
      appId="pipeline"
      homeHref="/pipeline/inbox"
      brand={{ left: "Deal", right: "Pipeline" }}
      links={LINKS}
    >
      {children}
    </AppChrome>
  );
}

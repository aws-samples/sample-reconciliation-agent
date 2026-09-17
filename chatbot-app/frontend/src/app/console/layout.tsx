import type { ReactNode } from "react";

// The console's own screens (`/console/*`) sit in the shell's content column like an app would, but
// they are not an app: no theme of their own, no access group, no BFF prefix. They use the shell's
// palette so the frame and the page read as one surface, and this layout provides the `<main>`
// landmark the shell leaves to whatever it wraps.
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <main className="console-root min-h-screen bg-[var(--shell-bg)] text-[var(--shell-ink)]">
      <div className="mx-auto max-w-[1100px] px-8 py-8">{children}</div>
    </main>
  );
}

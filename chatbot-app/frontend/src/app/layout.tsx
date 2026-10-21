import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import AuthWrapper from "@/components/AuthWrapper";
import { FontSizeProvider } from "@/components/FontSizeProvider";
import { AppShell } from "@/components/shell/AppShell";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  title: "Agentic Operations Console",
  description:
    "Trade reconciliation and deal pipeline agents behind one console",
  icons: {
    icon: "/recon-favicon.svg",
    shortcut: "/recon-favicon.svg",
    apple: "/recon-favicon.svg",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* No cross-origin stylesheet or font link belongs here. Every font this app uses comes from
          `next/font/google`, which downloads at build time and emits @font-face rules pointing at
          /_next/static/media — same origin. The CloudFront CSP (`style-src 'self' 'unsafe-inline'`)
          blocks anything else outright, so an external <link> is a console error, not a font. */}
      <head>
        <script src="/error-filter.js" />
      </head>
      <body className={`${manrope.variable} font-sans`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <FontSizeProvider>
            {/* The shell sits INSIDE the auth gate: it asks /api/me who is signed in, so it must not
                mount before there is a session to describe. Providers stay exactly as they were. */}
            <AuthWrapper>
              <AppShell>{children}</AppShell>
            </AuthWrapper>
          </FontSizeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

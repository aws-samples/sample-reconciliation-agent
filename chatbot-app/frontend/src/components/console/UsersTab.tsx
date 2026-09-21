"use client";

import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";

import {
  BUTTON_PRIMARY,
  INPUT_CLASS,
  Mono,
  Note,
  Section,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
  YesNo,
} from "@/components/console/primitives";
import type { ConsoleSettingsStore } from "@/components/console/useConsoleSettings";
import { APPS } from "@/lib/auth/apps";
import { accessCheck } from "@/lib/consoleApi";
import type { AccessCheckResult } from "@/lib/console/types";
import { parseGroupList } from "@/lib/shell/consoleSettingsForm";
import type { ConsoleViewer } from "@/lib/shell/viewer";

// The Users section: the current viewer as the console sees them, where membership is managed, and
// — for console admins — what a hypothetical set of groups would see.
//
// There is no user list on purpose. The console holds no users: identities and groups live in the
// identity provider, and the only thing the console can say about a person is what their groups
// resolve to. The checker answers that question without waiting for the person to sign in.

const MODE_LABEL: Record<ConsoleViewer["mode"], string> = {
  cognito: "Amazon Cognito user pool",
  okta: "Okta",
  entra: "Microsoft Entra ID",
  anonymous: "Anonymous (local development: no identity provider)",
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-app access and admin, for the viewer or for a checked group set. */
function AccessTable({
  apps,
  consoleAdmin,
  caption,
  testId,
}: {
  apps: AccessCheckResult["apps"];
  consoleAdmin: boolean;
  caption: string;
  testId: string;
}) {
  return (
    <table className={TABLE_CLASS} data-testid={testId}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASS}>
            Application
          </th>
          <th scope="col" className={TH_CLASS}>
            Access
          </th>
          <th scope="col" className={TH_CLASS}>
            Admin
          </th>
        </tr>
      </thead>
      <tbody>
        {APPS.map((app) => (
          <tr key={app.id}>
            <th scope="row" className={`${TD_CLASS} font-normal`}>
              {app.label}
            </th>
            <td className={TD_CLASS}>
              <YesNo value={apps[app.id]?.access === true} />
            </td>
            <td className={TD_CLASS}>
              <YesNo value={apps[app.id]?.admin === true} />
            </td>
          </tr>
        ))}
        <tr>
          <th scope="row" className={`${TD_CLASS} font-normal`}>
            Console settings
          </th>
          <td className={TD_CLASS} colSpan={2}>
            <YesNo value={consoleAdmin} /> <span className="text-[var(--shell-ink-dim)]">(console admin)</span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function AccessChecker() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AccessCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = parseGroupList(input);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await accessCheck(groups));
    } catch (err) {
      setResult(null);
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Effective access check"
      description="What a user holding exactly these groups would be able to open and administer, resolved by the server with the settings currently in force."
      testId="access-checker"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="access-check-groups" className="text-label">
          Groups, comma-separated
        </label>
        <div className="flex gap-2">
          <input
            id="access-check-groups"
            className={INPUT_CLASS}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="recon-analysts, deal-desk"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className={BUTTON_PRIMARY} disabled={busy}>
            <Search className="h-4 w-4" aria-hidden="true" />
            {busy ? "Checking…" : "Check access"}
          </button>
        </div>
        <p className="text-caption text-[var(--shell-ink-dim)]">
          An empty list answers for a signed-in user with no groups at all, which is what an open access group admits.
        </p>
      </form>
      {error && (
        <Note tone="error" testId="access-check-error">
          {error}
        </Note>
      )}
      {result && (
        <div className="flex flex-col gap-2">
          <p className="text-label text-[var(--shell-ink-dim)]">
            Groups checked:{" "}
            {result.groups.length === 0 ? (
              <em>none</em>
            ) : (
              result.groups.map((g, i) => (
                <span key={g}>
                  {i > 0 && ", "}
                  <Mono>{g}</Mono>
                </span>
              ))
            )}
          </p>
          <AccessTable
            apps={result.apps}
            consoleAdmin={result.consoleAdmin}
            caption="Effective access for the checked groups"
            testId="access-check-result"
          />
        </div>
      )}
    </Section>
  );
}

export function UsersTab({ viewer, store }: { viewer: ConsoleViewer; store: ConsoleSettingsStore }) {
  const envOnly = store.settings?.envOnly;
  return (
    <div className="flex flex-col gap-6">
      <Section title="You" description="How the console sees the current session." testId="current-viewer">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-label">
          <dt className="text-[var(--shell-ink-dim)]">Subject</dt>
          <dd>
            <Mono>{viewer.subject || "unknown"}</Mono>
          </dd>
          <dt className="text-[var(--shell-ink-dim)]">Mode</dt>
          <dd>{MODE_LABEL[viewer.mode] ?? viewer.mode}</dd>
          <dt className="text-[var(--shell-ink-dim)]">Groups</dt>
          <dd data-testid="viewer-groups">
            {viewer.groups.length === 0 ? (
              <em className="text-[var(--shell-ink-dim)]">none in the token</em>
            ) : (
              viewer.groups.map((g, i) => (
                <span key={g}>
                  {i > 0 && ", "}
                  <Mono>{g}</Mono>
                </span>
              ))
            )}
          </dd>
        </dl>
        <AccessTable
          apps={viewer.apps}
          consoleAdmin={viewer.console.admin}
          caption="Your access per application"
          testId="viewer-access"
        />
      </Section>

      <Section
        title="Where membership lives"
        description="The console reads groups; it never writes them."
        testId="membership-note"
      >
        <p className="text-label text-[var(--shell-ink-dim)]">
          Group membership is managed in the identity provider (an Amazon Cognito user pool, Okta or Microsoft
          Entra ID). Add or remove a person
          there and their next token carries the change; nothing on this screen alters who is in a group. Three
          switches are environment-only and can never be changed from the console, so an edit here cannot widen
          access past what the deployment allows or make someone a console admin:
        </p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-label" data-testid="env-only">
          <dt>
            <Mono>REQUIRE_ACCESS_GROUPS</Mono>
          </dt>
          <dd className="text-[var(--shell-ink-dim)]">
            {envOnly
              ? envOnly.requireAccessGroups
                ? "true: a blank access group denies everyone but the application's admins"
                : "not set: a blank access group is open to every authenticated user"
              : "whether a blank access group denies rather than opens"}
          </dd>
          <dt>
            <Mono>ALLOW_ANONYMOUS_API</Mono>
          </dt>
          <dd className="text-[var(--shell-ink-dim)]">
            {envOnly
              ? envOnly.anonymousMode
                ? "true: anonymous mode, every request is one local subject holding every configured group"
                : "not set: every request must carry a verified token"
              : "anonymous mode for local development (and its older per-app spellings)"}
          </dd>
          <dt>
            <Mono>CONSOLE_ADMIN_GROUP</Mono>
          </dt>
          <dd className="text-[var(--shell-ink-dim)]">
            {envOnly
              ? envOnly.consoleAdminGroup
                ? (
                    <>
                      <Mono>{envOnly.consoleAdminGroup}</Mono> may change these settings
                    </>
                  )
                : "unset: nobody is a console admin unless the deployment runs in anonymous mode"
              : "the group that may change these settings"}
          </dd>
        </dl>
      </Section>

      {viewer.console.admin && <AccessChecker />}
    </div>
  );
}

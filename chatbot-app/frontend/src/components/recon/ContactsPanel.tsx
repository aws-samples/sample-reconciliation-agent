"use client";

import { useEffect, useState } from "react";
import {
  createContact,
  deactivateContact,
  listContacts,
  updateContact,
  type Contact,
} from "@/lib/reconApi";
import { Eyebrow, Modal, Panel, Placeholder } from "@/components/recon/ui";

// The recipient list. This panel is the only place in the deployment where an email address can be
// entered: the agent's read tool projects the address away and no agent tool writes here at all, so
// "who may this system email" is answered on this screen and nowhere else.
//
// Nothing here validates in a way that matters. The BFF re-checks every field and the gateway
// interceptor re-derives the domain verdict on every send, so the messages below exist to save an
// operator a round trip, not to authorize anything.
//
// In particular the domain allowlist is ADVISORY on this screen. The admin owns the contact list, so
// any address can be stored in any domain; what the deployment's allowlist decides is whether a
// counterparty send to it is permitted, and that is decided at the gateway. Every place below that
// mentions a domain therefore describes a consequence at send time, never a refusal to save.

const INPUT =
  "rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-2 py-1.5 text-[12px] text-[var(--rc-ink)] disabled:opacity-50";
const BUTTON =
  "rc-mono rounded border px-3 py-1.5 text-[11px] uppercase tracking-[0.1em] transition-colors disabled:opacity-40";

const KINDS: { value: string; label: string; hint: string }[] = [
  {
    value: "counterparty",
    label: "Counterparty",
    hint: "an outside party an analyst may write to about a break",
  },
  {
    value: "internal_notification",
    label: "Internal notification",
    hint: "receives the resolution notice when a case closes",
  },
];

/** One editable row. Local state per row so an edit in progress survives a sibling's save. */
function ContactRow({
  contact,
  busy,
  onSaved,
  onError,
}: {
  contact: Contact;
  busy: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(contact.display_name);
  const [email, setEmail] = useState(contact.email);
  const [kind, setKind] = useState(contact.kind);
  const [saving, setSaving] = useState(false);

  // Re-sync when the list reloads under us — otherwise a row keeps showing the values this operator
  // typed even after someone else's change landed on the same contact.
  useEffect(() => {
    setName(contact.display_name);
    setEmail(contact.email);
    setKind(contact.kind);
  }, [contact.display_name, contact.email, contact.kind]);

  const dirty =
    name !== contact.display_name ||
    email !== contact.email ||
    kind !== contact.kind;

  const save = async () => {
    setSaving(true);
    try {
      await updateContact(contact.contact_id, {
        display_name: name.trim(),
        email: email.trim(),
        kind,
      });
      onSaved(`Saved ${name.trim()}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (active: boolean) => {
    setSaving(true);
    try {
      if (active) {
        await updateContact(contact.contact_id, { active: true });
        onSaved(`${contact.display_name} can receive email again.`);
      } else {
        await deactivateContact(contact.contact_id);
        onSaved(
          `${contact.display_name} deactivated — any approved draft addressed to them is now unsendable.`,
        );
      }
    } catch (e) {
      // The 409 on the last active internal_notification contact arrives here. Its message says to add
      // a replacement first, which is the whole instruction, so it is shown verbatim.
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = busy || saving;

  return (
    <tr
      className="border-t border-[var(--rc-line)]"
      style={{ opacity: contact.active ? 1 : 0.55 }}
    >
      <td className="py-2 pr-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          aria-label={`Display name for ${contact.contact_id}`}
          className={INPUT}
        />
      </td>
      <td className="py-2 pr-3">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={disabled}
          aria-label={`Email for ${contact.contact_id}`}
          className={INPUT}
        />
      </td>
      <td className="py-2 pr-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={disabled}
          aria-label={`Kind for ${contact.contact_id}`}
          className={INPUT}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">
        <span
          className="rc-pill"
          style={{
            color: contact.active ? "var(--rc-green)" : "var(--rc-ink-faint)",
          }}
        >
          {contact.active ? "active" : "inactive"}
        </span>
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={disabled || !dirty}
            title={dirty ? "Store these values" : "Nothing has changed yet"}
            className={`${BUTTON} border-[var(--rc-cyan)] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#04121a]`}
          >
            Save
          </button>
          {contact.active ? (
            <button
              type="button"
              onClick={() => setActive(false)}
              disabled={disabled}
              title="Stops every future send to this contact, and makes any already-approved draft addressed to them unsendable. The row is kept so historical cases still read correctly."
              className={`${BUTTON} border-[var(--rc-red)] text-[var(--rc-red)] hover:bg-[var(--rc-red)] hover:text-[#120404]`}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActive(true)}
              disabled={disabled}
              title="Allow sends to this contact again"
              className={`${BUTTON} border-[var(--rc-ink-faint)] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)]`}
            >
              Reactivate
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ContactsPanel() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The create form lives in a dialog rather than as a trailing row in the table. An empty row under
  // the real ones reads as a contact that exists, and its placeholder address reads as one someone
  // saved — a bad way to present the single screen that decides who this platform may email.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newKind, setNewKind] = useState("counterparty");

  const reload = async () => {
    try {
      setContacts(await listContacts());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const report = (message: string) => {
    setMsg(message);
    setError(null);
    void reload();
  };
  const fail = (message: string) => {
    setError(message);
    setMsg(null);
  };

  const add = async () => {
    setBusy(true);
    try {
      const { contact } = await createContact({
        display_name: newName.trim(),
        email: newEmail.trim(),
        kind: newKind,
      });
      setNewName("");
      setNewEmail("");
      setAdding(false);
      report(`Added ${contact.display_name}.`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const notifiers = (contacts ?? []).filter(
    (c) => c.kind === "internal_notification" && c.active,
  );

  return (
    <Panel className="rc-rise p-6">
      <div className="max-w-2xl">
        <Eyebrow title="Drafts and notifications store a contact id, never an address. The address is read from this table at the moment of sending, so deactivating a contact here stops mail to them immediately — including mail that was already approved.">
          Email contacts
        </Eyebrow>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
          Who this platform may write to. <strong>Counterparty</strong> contacts
          are the outside parties an analyst can address a break email to;{" "}
          <strong>internal notification</strong> contacts receive the notice
          when a case is resolved. This list answers who may be written to; the
          deployment&apos;s own send gate decides, at send time, whether a given
          counterparty address is permitted.
        </p>
        {contacts !== null && notifiers.length === 0 && (
          <p
            className="rc-mono mt-3 text-[12px]"
            style={{ color: "var(--rc-amber)" }}
          >
            No active internal notification contact — resolution notifications
            are being refused. Add one with the button below.
          </p>
        )}
      </div>

      <div className="mt-5">
        {loadError ? (
          <Placeholder kind="error">
            Failed to load contacts — {loadError}
          </Placeholder>
        ) : contacts === null ? (
          <Placeholder kind="loading">◆ loading contacts…</Placeholder>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="rc-eyebrow">
                <th className="w-[26%] pb-2 pr-3">Name</th>
                <th className="w-[30%] pb-2 pr-3">Email</th>
                <th className="w-[20%] pb-2 pr-3">Kind</th>
                <th className="w-[10%] pb-2 pr-3">State</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.length === 0 && (
                <tr className="border-t border-[var(--rc-line)]">
                  <td
                    colSpan={5}
                    className="rc-mono py-4 text-[12px] text-[var(--rc-ink-faint)]"
                  >
                    No contacts yet. Until one exists, no email can be sent.
                  </td>
                </tr>
              )}
              {contacts.map((c) => (
                <ContactRow
                  key={c.contact_id}
                  contact={c}
                  busy={busy}
                  onSaved={report}
                  onError={fail}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${BUTTON} border-[var(--rc-green)] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f]`}
        >
          Add new contact
        </button>
      </div>

      {adding && (
        <Modal
          title="Add New Contact"
          subtitle="Becomes addressable as soon as it is created. The address is read from this row at the moment of sending, never copied into a draft."
          onClose={() => setAdding(false)}
        >
          <label className="block">
            <span className="rc-eyebrow">Name</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
              placeholder="Counterparty AP team"
              aria-label="New contact display name"
              className={`${INPUT} mt-1`}
            />
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              What an analyst picks from when addressing an email.
            </span>
          </label>

          <label className="block">
            <span className="rc-eyebrow">Email</span>
            <input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              disabled={busy}
              placeholder="ap@counterparty.example"
              aria-label="New contact email"
              className={`${INPUT} mt-1`}
            />
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              {newKind === "counterparty"
                ? "Whether a send to this address is permitted is decided by the deployment's send gate, not here."
                : "Internal notification addresses are not domain-checked."}
            </span>
          </label>

          <label className="block">
            <span className="rc-eyebrow">Kind</span>
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              disabled={busy}
              aria-label="New contact kind"
              className={`${INPUT} mt-1`}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value} title={k.hint}>
                  {k.label}
                </option>
              ))}
            </select>
            <span className="rc-mono mt-1 block text-[11px] text-[var(--rc-ink-faint)]">
              {KINDS.find((k) => k.value === newKind)?.hint}
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {/* The reason is rendered rather than left in a tooltip: a disabled button that does
                nothing on click reads as broken. */}
            {(!newName.trim() || !newEmail.trim()) && (
              <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
                still needs{" "}
                {[
                  !newName.trim() ? "a name" : null,
                  !newEmail.trim() ? "an email" : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            )}
            <button
              type="button"
              onClick={add}
              disabled={busy || !newName.trim() || !newEmail.trim()}
              className={`${BUTTON} border-[var(--rc-green)] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f]`}
            >
              {busy ? "Creating…" : "Create contact"}
            </button>
          </div>
        </Modal>
      )}

      {msg && (
        <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">{msg}</p>
      )}
      {error && (
        <p
          className="rc-mono mt-4 text-[12px]"
          style={{ color: "var(--rc-amber)" }}
        >
          {error}
        </p>
      )}
    </Panel>
  );
}

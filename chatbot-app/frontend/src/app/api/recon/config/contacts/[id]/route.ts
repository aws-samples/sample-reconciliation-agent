import { NextResponse } from "next/server";
import { requireReconAdmin } from "@/lib/reconAdmin";
import {
  CONTACT_KINDS,
  ContactUnavailable,
  ContactValidationError,
  deactivateContact,
  getContactRow,
  listContacts,
  putContact,
  type ContactKind,
} from "@/lib/contactStore";
import { storableAddressReason } from "@/lib/emailPolicy";

// Edit and deactivate one contact.
//
// DELETE is a soft delete — `active = false`, never a DeleteItem. Cases keep the `contact_id` they
// were drafted against, so removing the row would make an old draft render a blank recipient with no
// way to tell whether it was never set or later revoked. Clearing `active` says the second thing, and
// it is also what makes deactivation a REVOCATION: every send resolves the id afresh, so an
// already-approved draft to a deactivated contact stops being sendable without anyone touching the case.
export const runtime = "nodejs";

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as {
    display_name?: string;
    email?: string;
    kind?: string;
    active?: boolean;
  };

  try {
    const existing = await getContactRow(id);
    // 404 rather than an upsert: PUT to an unknown id is almost always a stale UI, and creating a
    // recipient nobody asked for is the wrong way to be forgiving about it.
    if (!existing)
      return NextResponse.json(
        { error: `contact ${id} does not exist` },
        { status: 404 },
      );

    const displayName = (body.display_name ?? existing.display_name).trim();
    const email = (body.email ?? existing.email).trim();
    const kind = (body.kind ?? existing.kind).trim();
    if (!displayName)
      return NextResponse.json(
        { error: "display_name cannot be blank" },
        { status: 400 },
      );
    // Shape only, as on create: a string that is not an address reaches nobody however the
    // deployment is configured.
    const malformed = storableAddressReason(email);
    if (malformed)
      return NextResponse.json({ error: malformed }, { status: 400 });
    if (!(CONTACT_KINDS as readonly string[]).includes(kind))
      return NextResponse.json(
        { error: `kind must be one of ${CONTACT_KINDS.join(", ")}` },
        { status: 400 },
      );
    const contact = await putContact({
      contact: {
        contact_id: id,
        display_name: displayName,
        email,
        kind: kind as ContactKind,
        active:
          typeof body.active === "boolean" ? body.active : existing.active,
      },
      actor: who.actor,
    });
    return NextResponse.json({ contact });
  } catch (err) {
    if (err instanceof ContactValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;
  const { id } = await ctx.params;

  try {
    const existing = await getContactRow(id);
    if (!existing)
      return NextResponse.json(
        { error: `contact ${id} does not exist` },
        { status: 404 },
      );

    // Deactivating the LAST active internal_notification contact silently switches off every
    // resolution notification in the system — and it fails closed at the interceptor, which refuses a
    // notification send when the list is empty. That is a decision, not a side effect of tidying up a
    // list, so it is refused here and the operator has to add a replacement first.
    if (existing.kind === "internal_notification" && existing.active) {
      const others = (await listContacts()).filter(
        (c) =>
          c.kind === "internal_notification" && c.active && c.contact_id !== id,
      );
      if (others.length === 0)
        return NextResponse.json(
          {
            error:
              "this is the only active internal_notification contact; deactivating it would stop " +
              "all resolution notifications. Add a replacement first.",
          },
          { status: 409 },
        );
    }

    const contact = await deactivateContact({
      contactId: id,
      actor: who.actor,
    });
    return NextResponse.json({ contact });
  } catch (err) {
    if (err instanceof ContactUnavailable)
      return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

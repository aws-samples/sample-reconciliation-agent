import { NextResponse } from "next/server";
import { listContacts } from "@/lib/contactStore";

// The contact list an ANALYST may see, for the draft panel's recipient picker.
//
// Deliberately not `/api/recon/config/contacts`. Two things separate them:
//
//  - `email` is projected away here. An analyst confirms WHO an email goes to; the address is resolved
//    server-side at send time and never needs to reach a browser. This is the same projection the
//    agent's gateway read tool uses, for the same reason.
//  - it sits outside `/config/`, which carries the operator role gate. The picker is part of doing the
//    day job, so gating it as administration would lock analysts out of drafting.
//
// Active contacts only: an inactive one cannot be sent to, so offering it would only produce a
// selection the draft route then refuses.
export const runtime = "nodejs";

/**
 * List active contacts as `{contact_id, display_name, kind, active}`, addresses withheld.
 *
 * @param req - the request; `?kind=counterparty` narrows to one kind, absent returns both.
 * @returns 200 with `{contacts}`, or 500 when the table cannot be read.
 */
export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  try {
    const rows = await listContacts();
    const contacts = rows
      .filter((c) => c.active && (!kind || c.kind === kind))
      .map((c) => ({
        contact_id: c.contact_id,
        display_name: c.display_name,
        kind: c.kind,
        active: c.active,
      }));
    return NextResponse.json({ contacts });
  } catch (err) {
    return NextResponse.json(
      { error: `contact list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { requireReconAdmin } from "@/lib/reconAdmin";
import {
  TEMPLATE_PURPOSES,
  TemplateNotFound,
  TemplateValidationError,
  deactivateTemplate,
  getTemplateRow,
  putTemplate,
  type TemplatePurpose,
} from "@/lib/emailTemplateStore";

// Edit and deactivate one email template.
//
// Editing is safe in a way that editing a contact is not: by the time a draft exists, the subject and
// body were already rendered and persisted onto the case, and the gateway interceptor compares the
// outgoing message against THAT text. So a change here affects the next draft and never one already
// approved. Deactivating likewise stops new drafts from citing the template without invalidating the
// cases that already do — which is why DELETE clears `active` rather than removing the row.
export const runtime = "nodejs";

/** Trim and drop blanks from the comma-separated `variables` field the form submits. */
function normalizeVariables(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
  return String(raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    purpose?: string;
    subject_template?: string;
    body_template?: string;
    variables?: unknown;
    active?: boolean;
  };

  try {
    const existing = await getTemplateRow(id);
    if (!existing)
      return NextResponse.json(
        { error: `template ${id} does not exist` },
        { status: 404 },
      );

    const name = (body.name ?? existing.name).trim();
    const purpose = (body.purpose ?? existing.purpose).trim();
    const subject = (body.subject_template ?? existing.subject_template).trim();
    const text = (body.body_template ?? existing.body_template).trim();
    if (!name)
      return NextResponse.json(
        { error: "name cannot be blank" },
        { status: 400 },
      );
    if (!(TEMPLATE_PURPOSES as readonly string[]).includes(purpose))
      return NextResponse.json(
        { error: `purpose must be one of ${TEMPLATE_PURPOSES.join(", ")}` },
        { status: 400 },
      );
    if (!subject)
      return NextResponse.json(
        { error: "subject_template cannot be blank" },
        { status: 400 },
      );
    if (!text)
      return NextResponse.json(
        { error: "body_template cannot be blank" },
        { status: 400 },
      );

    const template = await putTemplate({
      template: {
        template_id: id,
        name,
        purpose: purpose as TemplatePurpose,
        subject_template: subject,
        body_template: text,
        variables:
          body.variables === undefined
            ? existing.variables
            : normalizeVariables(body.variables),
        active:
          typeof body.active === "boolean" ? body.active : existing.active,
      },
      actor: who.actor,
    });
    return NextResponse.json({ template });
  } catch (err) {
    // The undeclared-placeholder refusal arrives here, and its message names the offending variables.
    if (err instanceof TemplateValidationError)
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
    // No last-one-standing guard here, unlike contacts. A missing template does not silently disable
    // anything: `render_template` raises, the draft is persisted as `render_failed` with the reason on
    // it, and the case screen shows an operator what to fix. An absent notification CONTACT, by
    // contrast, is indistinguishable from a working system that simply had nothing to say.
    const template = await deactivateTemplate({
      templateId: id,
      actor: who.actor,
    });
    return NextResponse.json({ template });
  } catch (err) {
    if (err instanceof TemplateNotFound)
      return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

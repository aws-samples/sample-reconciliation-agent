import { NextResponse } from "next/server";
import { requireReconAdmin } from "@/lib/reconAdmin";
import {
  TEMPLATE_PURPOSES,
  TemplateValidationError,
  getTemplateRow,
  listTemplates,
  putTemplate,
  type TemplatePurpose,
} from "@/lib/emailTemplateStore";
import { randomUUID } from "node:crypto";

// Same-origin BFF for the operator's email templates — the only write path onto
// `recon-email-templates`. The agent's read tool returns names and declared variables but withholds
// the subject and body bytes, so the wording an email can carry is authored here and nowhere else.
//
// The save-time placeholder check is the one that matters: an undeclared `{{name}}` does not fail
// loudly at render, it renders the literal braces into a message a counterparty reads. Refusing the
// save is the only point at which the person who can fix it is still looking at it.
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

export async function GET(req: Request) {
  // Gated like the write. The subject and body bytes are here in full, and the agent's own read tool
  // deliberately withholds them — leaving the read open would hand out through the BFF exactly what the
  // tool projection exists to keep back.
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;
  try {
    // Deactivated templates included: a case can cite one, and the operator needs to see why.
    return NextResponse.json({ templates: await listTemplates() });
  } catch (err) {
    return NextResponse.json(
      { error: `template list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;

  const body = (await req.json().catch(() => ({}))) as {
    template_id?: string;
    name?: string;
    purpose?: string;
    subject_template?: string;
    body_template?: string;
    variables?: unknown;
  };
  const name = (body.name ?? "").trim();
  const purpose = (body.purpose ?? "").trim();
  const subject = (body.subject_template ?? "").trim();
  const text = (body.body_template ?? "").trim();
  if (!name)
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!(TEMPLATE_PURPOSES as readonly string[]).includes(purpose))
    return NextResponse.json(
      { error: `purpose must be one of ${TEMPLATE_PURPOSES.join(", ")}` },
      { status: 400 },
    );
  if (!subject)
    return NextResponse.json(
      { error: "subject_template is required" },
      { status: 400 },
    );
  if (!text)
    return NextResponse.json(
      { error: "body_template is required" },
      { status: 400 },
    );

  const templateId = (body.template_id ?? "").trim() || `tpl-${randomUUID()}`;
  try {
    // POST means create. Overwriting an existing template would silently rewrite the wording every
    // future draft of that purpose goes out with, so the collision is a 409 pointing at PUT.
    if (await getTemplateRow(templateId))
      return NextResponse.json(
        {
          error: `template ${templateId} already exists; use PUT to change it`,
        },
        { status: 409 },
      );
    const template = await putTemplate({
      template: {
        template_id: templateId,
        name,
        purpose: purpose as TemplatePurpose,
        subject_template: subject,
        body_template: text,
        variables: normalizeVariables(body.variables),
        active: true,
      },
      actor: who.actor,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    if (err instanceof TemplateValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

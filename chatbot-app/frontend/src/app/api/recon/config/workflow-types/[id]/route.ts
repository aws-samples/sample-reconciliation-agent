import { NextResponse } from "next/server";
import { requireReconAdmin } from "@/lib/reconAdmin";
import { workflowTypeRejectionReason } from "@/lib/workflowTypes";
import {
  WorkflowTypeUnavailable,
  deactivateWorkflowType,
  getWorkflowTypeRow,
  putWorkflowType,
  type WorkflowType,
} from "@/lib/workflowTypeStore";

// Edit and retire one workflow type.
//
// DELETE is a soft delete — `active = false`, never a DeleteItem. Retiring a type takes it out of the
// upload picker, which is the whole intent; removing the row would also erase the record of which
// extraction configuration the documents already uploaded under it were processed against, and that
// record is the only way to explain a document's extraction after the fact.
//
// The coherence rule is re-applied on every edit, not just on create. An operator switching a type
// from extraction to knowledge-base has to clear the version in the same change, because a row
// carrying both describes two destinations and the reader picks one.
export const runtime = "nodejs";

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    const existing = await getWorkflowTypeRow(id);
    // 404 rather than an upsert: a PUT to an unknown id is almost always a stale UI, and minting a
    // document category nobody asked for is the wrong way to be forgiving about it.
    if (!existing)
      return NextResponse.json(
        { error: `workflow type ${id} does not exist` },
        { status: 404 },
      );

    // Each field falls back to what is stored, so a partial edit is possible — but the row is then
    // validated WHOLE. Validating only the supplied fields is how a route change lands next to a
    // stale version that nobody re-read.
    const str = (key: keyof WorkflowType): string =>
      typeof body[key] === "string"
        ? (body[key] as string).trim()
        : ((existing[key] as string | undefined) ?? "");

    const candidate = {
      workflow_type_id: id,
      display_name: str("display_name"),
      route: str("route"),
      idp_config_version: str("idp_config_version"),
      kb_doc_type: str("kb_doc_type"),
      description: str("description"),
    };
    const reason = workflowTypeRejectionReason(candidate);
    if (reason) return NextResponse.json({ error: reason }, { status: 400 });

    const workflowType = await putWorkflowType({
      workflowType: {
        ...(candidate as unknown as WorkflowType),
        extra_metadata:
          (body.extra_metadata as Record<string, string> | undefined) ??
          existing.extra_metadata,
        active:
          typeof body.active === "boolean" ? body.active : existing.active,
      },
      actor: who.actor,
    });
    return NextResponse.json({ workflowType });
  } catch (err) {
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
    const workflowType = await deactivateWorkflowType({
      workflowTypeId: id,
      actor: who.actor,
    });
    return NextResponse.json({ workflowType });
  } catch (err) {
    if (err instanceof WorkflowTypeUnavailable)
      return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-auth";
import { requireReconAdmin } from "@/lib/reconAdmin";
import { workflowTypeRejectionReason } from "@/lib/workflowTypes";
import {
  getWorkflowTypeRow,
  listWorkflowTypes,
  putWorkflowType,
  type WorkflowType,
} from "@/lib/workflowTypeStore";

// Same-origin BFF for the workflow-type list — what an operator may upload, and where each kind of
// upload goes. The only write path onto `recon-workflow-types` in the deployment.
//
// Validation happens here rather than in the form, because the form is a convenience for the person
// filling it in and anything that can be skipped is not a check. The rule itself lives in
// `workflowTypes.ts` so it can be tested without an AWS client; this route applies it.
//
// Every WRITE is admin-gated. GET is not: it needs one authenticated caller and nothing more, because
// the Documents tab reads this list to decide which of the document pipeline's rows belong to this
// deployment at all, and that tab is open to an analyst. The list carries type ids, display names,
// routes and configuration-version names — no addresses, no message bodies, nothing an analyst could
// not already infer from the upload picker.
export const runtime = "nodejs";

/** Parse the free-form `extra_metadata` map, rejecting non-string values rather than coercing them. */
function readExtraMetadata(
  raw: unknown,
): { ok: Record<string, string> } | { error: string } {
  if (raw === undefined || raw === null) return { ok: {} };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { error: "extra_metadata must be an object of string values" };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // These land as S3 object metadata, which is string-only. Coercing a number here would store
    // something the upload then stamps as "3" without anyone having chosen that.
    if (typeof v !== "string")
      return { error: `extra_metadata.${k} must be a string` };
    out[k] = v;
  }
  return { ok: out };
}

export async function GET(req: Request) {
  // Authenticated, not admin — see the note above. Still verified from the token rather than from
  // anything the request claims about itself.
  const auth = await authorizeRequest(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  try {
    // Deactivated rows included. They are why a document uploaded last month was extracted against
    // the version it was, and a list that hides them turns "retired" into "never existed".
    return NextResponse.json({ workflowTypes: await listWorkflowTypes() });
  } catch (err) {
    return NextResponse.json(
      { error: `workflow-type list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const candidate = {
    workflow_type_id: String(body.workflow_type_id ?? "").trim(),
    display_name: String(body.display_name ?? "").trim(),
    route: String(body.route ?? "").trim(),
    idp_config_version: String(body.idp_config_version ?? "").trim(),
    kb_doc_type: String(body.kb_doc_type ?? "").trim(),
    description: String(body.description ?? "").trim(),
  };
  const reason = workflowTypeRejectionReason(candidate);
  if (reason) return NextResponse.json({ error: reason }, { status: 400 });

  const metadata = readExtraMetadata(body.extra_metadata);
  if ("error" in metadata)
    return NextResponse.json({ error: metadata.error }, { status: 400 });

  try {
    // POST means CREATE. Colliding with an existing id would silently redirect every future upload
    // of that category somewhere else, so it is a 409 and the caller is pointed at PUT.
    if (await getWorkflowTypeRow(candidate.workflow_type_id))
      return NextResponse.json(
        {
          error: `workflow type ${candidate.workflow_type_id} already exists; use PUT to change it`,
        },
        { status: 409 },
      );
    const workflowType = await putWorkflowType({
      workflowType: {
        ...(candidate as unknown as WorkflowType),
        extra_metadata: metadata.ok,
        active: true,
      },
      actor: who.actor,
    });
    return NextResponse.json({ workflowType }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

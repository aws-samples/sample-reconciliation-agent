import { NextResponse } from "next/server";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// Harness config versions: list + create + archive. S3 documents under harness-configs/v<NNNN>.json.
//
// A version's `system_prompt` is a SNAPSHOT taken when the version was saved. It is never rewritten,
// so it stays an honest record of what was deployed — but that also means it does not follow later
// edits made in the Skills tab, which writes the shared prompt object (system-prompt.md) directly
// via PUT /api/recon/system-prompt. After such an edit the pointer still names the last deployed
// version, so a plain "LIVE" badge would claim text that is no longer in effect. GET therefore
// compares the live prompt object against the deployed version's snapshot and reports
// `liveMatchesDeployed` so the UI can say "LIVE · edited since deploy" instead of lying.
//
// Archiving is the one field that IS mutated on an existing document: it is list-visibility
// metadata, not prompt content. There is deliberately no delete — a deployed version is the
// rollback target and the documents are the audit trail of what ran.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const PREFIX = "harness-configs/";
// The shared core policy both Tier-2 backends read (see backend/recon_core/prompt_source.py).
const CORE_PROMPT_KEY = process.env.SYSTEM_PROMPT_KEY ?? "system-prompt.md";
const POINTER_PARAM =
  process.env.HARNESS_CONFIG_VERSION_PARAM ??
  `/${process.env.NAME_PREFIX ?? "recon-dev"}/harness-config-version`;

function s3() {
  return new S3Client({ region: REGION });
}
function ssm() {
  return new SSMClient({ region: REGION });
}

interface ConfigDoc {
  version?: string;
  created_at?: string;
  comment?: string;
  system_prompt?: string;
  archived?: boolean;
  archived_at?: string | null;
}

/** Read the deployed-version pointer. Returns null when it has never been set. */
async function readPointer(): Promise<string | null> {
  try {
    const p = await ssm().send(
      new GetParameterCommand({ Name: POINTER_PARAM }),
    );
    return p.Parameter?.Value?.trim() ?? null;
  } catch {
    // ParameterNotFound: nothing has been deployed yet. Not an error for a list/archive call.
    return null;
  }
}

/** Fetch and parse one config-version document. */
async function readConfig(
  client: S3Client,
  version: string,
): Promise<ConfigDoc> {
  const got = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${version}.json` }),
  );
  return JSON.parse((await got.Body?.transformToString()) ?? "{}") as ConfigDoc;
}

export async function GET(req: Request) {
  try {
    const includeArchived =
      new URL(req.url).searchParams.get("includeArchived") === "1";
    const client = s3();
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }),
    );
    const all: ConfigDoc[] = [];
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key?.endsWith(".json")) continue;
      const got = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
      );
      const body = JSON.parse(
        (await got.Body?.transformToString()) ?? "{}",
      ) as ConfigDoc;
      all.push(body);
    }
    // Sort by version descending.
    all.sort((a, b) => (b.version ?? "").localeCompare(a.version ?? ""));

    const deployed = await readPointer();

    // Drift: is the prompt actually in effect still the deployed version's snapshot?
    // null = undeterminable (nothing deployed, no snapshot, or the object is unreadable) — the UI
    // renders that as unknown rather than as agreement.
    let liveMatchesDeployed: boolean | null = null;
    let livePromptChars: number | null = null;
    // Looked up in `all` (not the filtered list) so drift is still reported if the deployed
    // version was archived out of view.
    const deployedDoc = deployed
      ? all.find((c) => c.version === deployed)
      : undefined;
    try {
      const live = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: CORE_PROMPT_KEY }),
      );
      const liveText = (await live.Body?.transformToString()) ?? "";
      livePromptChars = liveText.length;
      if (deployedDoc?.system_prompt) {
        // Trimmed compare: the Skills-tab editor can add or drop a trailing newline on save, and
        // flagging that as drift would train the user to ignore the badge.
        liveMatchesDeployed =
          liveText.trim() === deployedDoc.system_prompt.trim();
      }
    } catch {
      // The shared prompt object is not readable — leave drift unknown, still return the versions.
    }

    const configs = includeArchived ? all : all.filter((c) => !c.archived);
    return NextResponse.json({
      configs,
      deployed,
      liveMatchesDeployed,
      livePromptChars,
      archivedCount: all.filter((c) => c.archived).length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

// Create a new config version: { comment, system_prompt, model_id, max_iterations, skills }
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { comment, system_prompt, model_id, max_iterations, skills } = body;
    if (!system_prompt) {
      return NextResponse.json(
        { error: "system_prompt is required" },
        { status: 400 },
      );
    }

    // Determine the next version number by listing existing.
    const client = s3();
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }),
    );
    const existing = (listed.Contents ?? [])
      .map((o) => o.Key?.replace(PREFIX, "").replace(".json", "") ?? "")
      .filter((k) => k.startsWith("v"))
      .map((k) => parseInt(k.slice(1), 10))
      .filter((n) => !isNaN(n));
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
    const version = `v${String(next).padStart(4, "0")}`;

    const config = {
      version,
      created_at: new Date().toISOString(),
      comment: comment ?? "",
      system_prompt,
      model_id: model_id ?? "us.anthropic.claude-sonnet-5",
      max_iterations: max_iterations ?? 12,
      skills: skills ?? [],
      // Numbering counts every document, archived or not, so a version number is never reused.
      archived: false,
    };

    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${PREFIX}${version}.json`,
        Body: JSON.stringify(config, null, 2),
        ContentType: "application/json",
      }),
    );

    return NextResponse.json(config, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

// Archive / unarchive a version: { version, archived }. A soft flag, never a delete: the deployed
// version is the rollback target and the document set is the record of every prompt that ran.
export async function PATCH(req: Request) {
  try {
    const { version, archived } = (await req.json()) as {
      version?: string;
      archived?: boolean;
    };
    if (!version || !version.startsWith("v")) {
      return NextResponse.json(
        { error: "version is required (e.g. v0003)" },
        { status: 400 },
      );
    }
    if (typeof archived !== "boolean") {
      return NextResponse.json(
        { error: "archived must be true or false" },
        { status: 400 },
      );
    }

    // Refuse to hide the version that is currently deployed: its snapshot is what the live prompt
    // is compared against for drift, and it is the thing a rollback returns to.
    if (archived) {
      const deployed = await readPointer();
      if (deployed === version) {
        return NextResponse.json(
          {
            error: `Config ${version} is deployed — deploy another version before archiving it`,
          },
          { status: 409 },
        );
      }
    }

    const client = s3();
    const cfg = await readConfig(client, version);
    if (!cfg.version) {
      return NextResponse.json(
        { error: `Config ${version} is malformed — no version field` },
        { status: 409 },
      );
    }
    const updated: ConfigDoc = {
      ...cfg,
      archived,
      archived_at: archived ? new Date().toISOString() : null,
    };
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${PREFIX}${version}.json`,
        Body: JSON.stringify(updated, null, 2),
        ContentType: "application/json",
      }),
    );

    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

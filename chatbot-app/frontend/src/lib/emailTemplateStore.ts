/**
 * The operator-owned email templates table (`recon-email-templates`), for the Config tab only.
 *
 * A template is the *wording* the platform is allowed to send. The agent picks a `template_id` and
 * supplies values for the declared `variables`; the platform renders it. Nothing here is on the send
 * path — by the time an email goes out, the subject and body were already rendered and persisted onto
 * the case, and the gateway interceptor compares against that persisted text. So a change here
 * affects the NEXT draft, never one already approved, which is what makes editing a template safe.
 *
 * The authority for the rules below is `backend/contacts/store.py`'s `TemplateStore`. This copy exists
 * because the Config tab writes through the BFF, and a save that the Python would have refused should
 * be refused here too — with a message naming the offending placeholders, while the operator is still
 * looking at the form.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { nowStamp, scanAll } from "@/lib/contactStore";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TEMPLATES_TABLE =
  process.env.TEMPLATES_TABLE ?? "recon-dev-email-templates";

/** What a template may be used for. Deliberately the same two values as a contact's `kind`. */
export type TemplatePurpose = "counterparty" | "internal_notification";

/**
 * The two purposes, as data.
 *
 * Mirrors `TEMPLATE_PURPOSES` in `backend/contacts/store.py`, which is itself defined as being the
 * contact kinds — a template exists to address someone, so a purpose with no matching kind of contact
 * could never be used.
 */
export const TEMPLATE_PURPOSES: readonly TemplatePurpose[] = [
  "counterparty",
  "internal_notification",
];

/** A stored template row. */
export interface EmailTemplate {
  template_id: string;
  name: string;
  purpose: TemplatePurpose;
  subject_template: string;
  body_template: string;
  /** The `{{placeholders}}` the two templates above are allowed to contain. */
  variables: string[];
  active: boolean;
  /** 0 on create, +1 per save. Same meaning as a draft's revision, so the two can sit side by side. */
  revision: number;
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

/** An operator's input was refused. Distinct from a DynamoDB failure so the route can answer 400. */
export class TemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

/** No template answers to this id. */
export class TemplateNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateNotFound";
  }
}

function ddb() {
  return new DynamoDBClient({ region: REGION });
}

/**
 * The distinct `{{name}}` placeholders a template string contains.
 *
 * Mirrors `placeholders_in` in `backend/recon_core/templating.py`, down to the two decisions that
 * matter: inner whitespace is tolerated (`{{ reference }}` IS the placeholder `reference`, because
 * operators type it that way), and the name is restricted to word characters so a placeholder can
 * never carry an expression. Getting the whitespace rule wrong in this direction would be the bad
 * one — this copy would accept a template the renderer then substitutes differently.
 *
 * @param template - the raw subject or body text.
 * @returns the placeholder names, each once.
 */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const m of (template ?? "").matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g))
    found.add(m[1]);
  return [...found];
}

/**
 * Every template, INCLUDING deactivated ones.
 *
 * @returns the raw rows, sorted by name so the table does not reshuffle between saves.
 */
export async function listTemplates(): Promise<EmailTemplate[]> {
  const rows = (await scanAll(TEMPLATES_TABLE)) as unknown as EmailTemplate[];
  return rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * One raw template row, or null when the id is unknown.
 *
 * Returns deactivated rows too, because the operator path has to read one in order to edit it.
 *
 * @param templateId - the partition key.
 * @returns the row, or null.
 */
export async function getTemplateRow(
  templateId: string,
): Promise<EmailTemplate | null> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: TEMPLATES_TABLE,
      Key: { template_id: { S: templateId } },
    }),
  );
  return resp.Item ? (unmarshall(resp.Item) as EmailTemplate) : null;
}

/**
 * Create or replace one template, validating its placeholders against its own declaration.
 *
 * @param template - must carry `template_id`, `name`, `purpose`, `subject_template` and
 *   `body_template`. `variables` defaults to the empty list, which is only valid for a template that
 *   uses no placeholders at all.
 * @param actor - the authenticated principal making the change.
 * @returns the row as written, with `revision` set.
 * @throws TemplateValidationError on a missing attribute, an unknown `purpose`, or a placeholder that
 *   `variables` does not declare. Checked on SAVE rather than on render, because by render time the
 *   operator who could fix it is no longer looking — and an undeclared placeholder does not fail
 *   loudly at render, it renders the literal `{{name}}` into an email.
 */
export async function putTemplate({
  template,
  actor,
}: {
  template: Partial<EmailTemplate>;
  actor: string;
}): Promise<EmailTemplate> {
  for (const key of [
    "template_id",
    "name",
    "purpose",
    "subject_template",
    "body_template",
  ] as const) {
    if (!template[key])
      throw new TemplateValidationError(`template is missing ${key}`);
  }
  if (!TEMPLATE_PURPOSES.includes(template.purpose as TemplatePurpose))
    throw new TemplateValidationError(
      `template purpose ${template.purpose} is not one of ${TEMPLATE_PURPOSES.join(", ")}`,
    );
  const declared = new Set(template.variables ?? []);
  const used = new Set([
    ...placeholdersIn(template.subject_template!),
    ...placeholdersIn(template.body_template!),
  ]);
  const undeclared = [...used].filter((v) => !declared.has(v)).sort();
  if (undeclared.length > 0)
    throw new TemplateValidationError(
      `template uses undeclared variables: ${undeclared.join(", ")}`,
    );
  const existing = await getTemplateRow(template.template_id!);
  const now = nowStamp();
  const row: EmailTemplate = {
    ...(existing ?? {}),
    ...(template as EmailTemplate),
    variables: [...(template.variables ?? [])],
    active: Boolean(template.active ?? existing?.active ?? true),
    revision: existing ? Number(existing.revision ?? 0) + 1 : 0,
    created_by: existing?.created_by ?? actor,
    created_at: existing?.created_at ?? now,
    updated_by: actor,
    updated_at: now,
  };
  await ddb().send(
    new PutItemCommand({
      TableName: TEMPLATES_TABLE,
      Item: marshall(row, { removeUndefinedValues: true }),
    }),
  );
  return row;
}

/**
 * Soft-delete one template by clearing `active`.
 *
 * Never a `DeleteItem`, for the same reason as a contact: cases keep the `template_id` they were
 * drafted from, and a missing row would make an old case unexplainable. Deactivating stops NEW drafts
 * from citing it, which is the whole intent.
 *
 * @param templateId - the template to deactivate.
 * @param actor - the authenticated principal making the change.
 * @returns the row as written.
 * @throws TemplateNotFound when no such template exists.
 */
export async function deactivateTemplate({
  templateId,
  actor,
}: {
  templateId: string;
  actor: string;
}): Promise<EmailTemplate> {
  const existing = await getTemplateRow(templateId);
  if (!existing)
    throw new TemplateNotFound(`template ${templateId} does not exist`);
  const row: EmailTemplate = {
    ...existing,
    active: false,
    updated_by: actor,
    updated_at: nowStamp(),
  };
  await ddb().send(
    new PutItemCommand({
      TableName: TEMPLATES_TABLE,
      Item: marshall(row, { removeUndefinedValues: true }),
    }),
  );
  return row;
}

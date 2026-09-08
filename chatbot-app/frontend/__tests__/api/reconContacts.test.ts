// @vitest-environment node
/**
 * The operator's contact and template CRUD — the only write path onto either table.
 *
 * What these tests are actually protecting is the set of refusals. Every one of them exists because
 * the corresponding acceptance would be silent: a contact stored with the wrong `kind` is unsendable
 * and nothing says so, a template with an undeclared placeholder renders literal braces into mail a
 * counterparty reads, and deactivating the last notification contact switches off every resolution
 * notification in the system. So the assertions are mostly "this returned 400/409 AND wrote nothing".
 *
 * The node environment is deliberate, for the same reason as `reconCaseApprove.test.ts`: the routes
 * import `requireReconAdmin`, which pulls in `jose`, and jsdom's cross-realm `Uint8Array` makes it throw
 * before any assertion runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CONTACTS_TABLE = "recon-dev-contacts";
process.env.TEMPLATES_TABLE = "recon-dev-email-templates";
process.env.COUNTERPARTY_EMAIL_DOMAINS = "counterparty.example";

const ddbSend = vi.fn();
const requireReconAdmin = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
  PutItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Put", ...i })),
  ScanCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Scan", ...i })),
}));
vi.mock("@/lib/reconAdmin", () => ({ requireReconAdmin }));

const { marshall } = await import("@aws-sdk/util-dynamodb");
const contactsRoute = await import("@/app/api/recon/config/contacts/route");
const contactRoute = await import("@/app/api/recon/config/contacts/[id]/route");
const templatesRoute = await import("@/app/api/recon/config/templates/route");
const templateRoute =
  await import("@/app/api/recon/config/templates/[id]/route");

type Row = Record<string, unknown>;

/**
 * Answer the SDK from an in-memory pair of tables.
 *
 * Keyed by table name rather than by call order, because these routes read before they write and the
 * order changes as validation short-circuits — a call-order fixture would make an added `if` look
 * like a broken test.
 */
function seed({
  contacts = [],
  templates = [],
}: {
  contacts?: Row[];
  templates?: Row[];
}): { puts: Row[] } {
  const puts: Row[] = [];
  const byTable: Record<string, Row[]> = {
    "recon-dev-contacts": contacts,
    "recon-dev-email-templates": templates,
  };
  const keyOf = (t: string) =>
    t === "recon-dev-contacts" ? "contact_id" : "template_id";
  ddbSend.mockImplementation(async (cmd: Row) => {
    const table = String(cmd.TableName);
    const rows = byTable[table] ?? [];
    if (cmd.__cmd === "Scan")
      return {
        Items: rows.map((r) => marshall(r, { removeUndefinedValues: true })),
      };
    if (cmd.__cmd === "Get") {
      const key = keyOf(table);
      const wanted = (cmd.Key as Record<string, { S: string }>)[key].S;
      const found = rows.find((r) => r[key] === wanted);
      return found
        ? { Item: marshall(found, { removeUndefinedValues: true }) }
        : {};
    }
    if (cmd.__cmd === "Put") {
      puts.push(cmd.Item as Row);
      return {};
    }
    return {};
  });
  return { puts };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CONTACT: Row = {
  contact_id: "notify-primary",
  display_name: "Reconciliation Operations",
  email: "ops@operator.example",
  kind: "internal_notification",
  active: true,
};

const TEMPLATE: Row = {
  template_id: "tpl-1",
  name: "Ask for a reference",
  purpose: "counterparty",
  subject_template: "Reference {{reference}}",
  body_template: "Please confirm {{reference}}.",
  variables: ["reference"],
  active: true,
  revision: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireReconAdmin.mockResolvedValue({ actor: "operator@x.com" });
});

describe("POST /api/recon/config/contacts", () => {
  it("creates a counterparty contact in an allowed domain and stamps the actor", async () => {
    const { puts } = seed({});
    const res = await contactsRoute.POST(
      post("http://x/api/recon/config/contacts", {
        contact_id: "cp-ap",
        display_name: "Counterparty AP",
        email: "ap@counterparty.example",
        kind: "counterparty",
      }),
    );

    expect(res.status).toBe(201);
    const { contact } = (await res.json()) as { contact: Row };
    expect(contact.contact_id).toBe("cp-ap");
    expect(contact.active).toBe(true);
    // Both stamps present on a create, and both name the verified principal rather than a default.
    expect(contact.created_by).toBe("operator@x.com");
    expect(contact.updated_by).toBe("operator@x.com");
    expect(puts).toHaveLength(1);
  });

  it("stores any well-formed counterparty address and says nothing about the send gate", async () => {
    // The allowlist governs SENDING, and this route is not the gate. An admin maintains addresses for
    // counterparties the deployment has not been configured to email yet, so the row is written with
    // no commentary. It previously came back with an amber advisory attached to the 201, which read as
    // a BLOCKED SAVE on a save that had in fact succeeded -- the reason the advisory is gone.
    const { puts } = seed({});
    const res = await contactsRoute.POST(
      post("http://x/api/recon/config/contacts", {
        display_name: "Not Allowed",
        email: "ap@evil.example",
        kind: "counterparty",
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { contact: Row; warning?: unknown };
    expect(body.contact.email).toBe("ap@evil.example");
    // No `warning` key at all: its absence is the contract, not merely a null value.
    expect("warning" in body).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("refuses an unknown kind", async () => {
    const { puts } = seed({});
    const res = await contactsRoute.POST(
      post("http://x/api/recon/config/contacts", {
        display_name: "Someone",
        email: "someone@counterparty.example",
        kind: "notification",
      }),
    );

    // "notification" is the sendPurpose on the wire, not a contact kind — an easy and silent mistake,
    // because a row stored with it would simply never satisfy any send.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("kind must be one of");
    expect(puts).toHaveLength(0);
  });

  it("409s rather than overwriting an existing contact id", async () => {
    const { puts } = seed({ contacts: [CONTACT] });
    const res = await contactsRoute.POST(
      post("http://x/api/recon/config/contacts", {
        contact_id: "notify-primary",
        display_name: "Someone Else",
        email: "else@counterparty.example",
        kind: "counterparty",
      }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("use PUT");
    expect(puts).toHaveLength(0);
  });

  it("passes the authorization failure through untouched", async () => {
    const { puts } = seed({});
    const { NextResponse } = await import("next/server");
    requireReconAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "no token" }, { status: 401 }),
    });

    const res = await contactsRoute.POST(
      post("http://x/api/recon/config/contacts", CONTACT),
    );

    expect(res.status).toBe(401);
    expect(puts).toHaveLength(0);
  });
});

describe("GET /api/recon/config/contacts", () => {
  it("returns deactivated contacts too", async () => {
    // The Config tab has to show them: a deactivated contact is WHY an old draft is unsendable, and a
    // list that hides it turns "revoked" into "never existed".
    seed({
      contacts: [CONTACT, { ...CONTACT, contact_id: "gone", active: false }],
    });
    const res = await contactsRoute.GET(
      new Request("http://x/api/recon/config/contacts"),
    );

    expect(res.status).toBe(200);
    const { contacts } = (await res.json()) as { contacts: Row[] };
    expect(contacts.map((c) => c.contact_id).sort()).toEqual([
      "gone",
      "notify-primary",
    ]);
  });
});

describe("PUT /api/recon/config/contacts/[id]", () => {
  it("preserves created_by while updating updated_by", async () => {
    const { puts } = seed({
      contacts: [
        {
          ...CONTACT,
          created_by: "founder@x.com",
          created_at: "2026-01-01T00:00:00",
        },
      ],
    });
    requireReconAdmin.mockResolvedValue({ actor: "second@x.com" });

    const res = await contactRoute.PUT(
      put("http://x/api/recon/config/contacts/notify-primary", {
        display_name: "Recon Ops (renamed)",
      }),
      { params: Promise.resolve({ id: "notify-primary" }) },
    );

    expect(res.status).toBe(200);
    const { contact } = (await res.json()) as { contact: Row };
    expect(contact.display_name).toBe("Recon Ops (renamed)");
    // Who ADDED a recipient is the interesting audit question, so an edit must not rewrite it.
    expect(contact.created_by).toBe("founder@x.com");
    expect(contact.updated_by).toBe("second@x.com");
    expect(puts).toHaveLength(1);
  });

  it("404s on an unknown id instead of creating one", async () => {
    const { puts } = seed({});
    const res = await contactRoute.PUT(
      put("http://x/api/recon/config/contacts/nope", {
        display_name: "Ghost",
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
    expect(puts).toHaveLength(0);
  });
});

describe("DELETE /api/recon/config/contacts/[id]", () => {
  it("soft-deletes, never issuing a DeleteItem", async () => {
    const { puts } = seed({
      contacts: [
        CONTACT,
        { ...CONTACT, contact_id: "notify-backup", display_name: "Backup" },
      ],
    });

    const res = await contactRoute.DELETE(
      new Request("http://x/api/recon/config/contacts/notify-primary", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "notify-primary" }) },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).contact.active).toBe(false);
    // A Put clearing `active`, and no Delete command anywhere: cases keep the contact_id they cite.
    expect(puts).toHaveLength(1);
    expect(
      ddbSend.mock.calls.filter(([cmd]) => (cmd as Row).__cmd === "Delete"),
    ).toHaveLength(0);
  });

  it("409s on the last active internal_notification contact", async () => {
    const { puts } = seed({
      contacts: [
        CONTACT,
        // A counterparty contact is not a substitute: the interceptor only accepts an
        // internal_notification address for a notification send.
        {
          ...CONTACT,
          contact_id: "cp-ap",
          kind: "counterparty",
          email: "ap@counterparty.example",
        },
        // Nor is a deactivated one.
        { ...CONTACT, contact_id: "notify-old", active: false },
      ],
    });

    const res = await contactRoute.DELETE(
      new Request("http://x/api/recon/config/contacts/notify-primary", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "notify-primary" }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("only active");
    expect(puts).toHaveLength(0);
  });

  it("allows deactivating a counterparty contact even as the only one", async () => {
    // The guard is specific to notifications. A counterparty contact going away breaks nothing
    // silently — the analyst simply has no one to pick, which the draft form says out loud.
    const { puts } = seed({
      contacts: [
        CONTACT,
        {
          ...CONTACT,
          contact_id: "cp-ap",
          kind: "counterparty",
          email: "ap@counterparty.example",
        },
      ],
    });

    const res = await contactRoute.DELETE(
      new Request("http://x/api/recon/config/contacts/cp-ap", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "cp-ap" }) },
    );

    expect(res.status).toBe(200);
    expect(puts).toHaveLength(1);
  });
});

describe("POST /api/recon/config/templates", () => {
  it("creates at revision 0 and accepts whitespace inside a placeholder", async () => {
    const { puts } = seed({});
    const res = await templatesRoute.POST(
      post("http://x/api/recon/config/templates", {
        name: "Chase a reference",
        purpose: "counterparty",
        subject_template: "Reference {{ reference }}",
        body_template: "Please confirm {{reference}} for {{amount}}.",
        variables: "reference, amount",
      }),
    );

    expect(res.status).toBe(201);
    const { template } = (await res.json()) as { template: Row };
    // `{{ reference }}` with spaces IS the placeholder `reference` — the renderer tolerates the
    // whitespace, so this validation has to as well or it would refuse a template that renders fine.
    expect(template.revision).toBe(0);
    expect(template.variables).toEqual(["reference", "amount"]);
    expect(puts).toHaveLength(1);
  });

  it("refuses a template whose body uses an undeclared placeholder", async () => {
    const { puts } = seed({});
    const res = await templatesRoute.POST(
      post("http://x/api/recon/config/templates", {
        name: "Broken",
        purpose: "counterparty",
        subject_template: "Reference {{reference}}",
        body_template: "Confirm {{reference}} paid on {{value_date}}.",
        variables: "reference",
      }),
    );

    expect(res.status).toBe(400);
    // The offending name is in the message: the operator can only fix this if told which one it is.
    expect((await res.json()).error).toBe(
      "template uses undeclared variables: value_date",
    );
    expect(puts).toHaveLength(0);
  });

  it("refuses an unknown purpose", async () => {
    const { puts } = seed({});
    const res = await templatesRoute.POST(
      post("http://x/api/recon/config/templates", {
        name: "Wrong purpose",
        purpose: "notification",
        subject_template: "Hi",
        body_template: "Hello",
        variables: "",
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("purpose must be one of");
    expect(puts).toHaveLength(0);
  });
});

describe("PUT /api/recon/config/templates/[id]", () => {
  it("bumps the revision on every save", async () => {
    const { puts } = seed({ templates: [{ ...TEMPLATE, revision: 3 }] });
    const res = await templateRoute.PUT(
      put("http://x/api/recon/config/templates/tpl-1", {
        body_template: "Kindly confirm {{reference}}.",
      }),
      { params: Promise.resolve({ id: "tpl-1" }) },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).template.revision).toBe(4);
    expect(puts).toHaveLength(1);
  });

  it("refuses an edit that introduces an undeclared placeholder", async () => {
    const { puts } = seed({ templates: [TEMPLATE] });
    const res = await templateRoute.PUT(
      put("http://x/api/recon/config/templates/tpl-1", {
        body_template: "Confirm {{reference}} and {{iban}}.",
      }),
      { params: Promise.resolve({ id: "tpl-1" }) },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("undeclared variables: iban");
    expect(puts).toHaveLength(0);
  });
});

describe("DELETE /api/recon/config/templates/[id]", () => {
  it("soft-deletes and 404s on an unknown id", async () => {
    const { puts } = seed({ templates: [TEMPLATE] });

    const ok = await templateRoute.DELETE(
      new Request("http://x/api/recon/config/templates/tpl-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "tpl-1" }) },
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).template.active).toBe(false);

    const missing = await templateRoute.DELETE(
      new Request("http://x/api/recon/config/templates/nope", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(missing.status).toBe(404);
    expect(puts).toHaveLength(1);
  });
});

// Parse/validate a SKILL.md's `--- key: value --- body` frontmatter. Mirrors the Python
// skills_loader._parse so the UI catalog matches what the agent reads from S3.

export interface SkillMeta {
  name: string;
  description: string;
  // Gateway tools the skill uses (frontmatter `tools: [a, b]`).
  tools: string[];
  // Optional per-skill model override (frontmatter `model:`), else null.
  model: string | null;
}

// Parse a frontmatter list value `[a, b, c]` (or bare `a, b`) into a string array.
function parseList(value: string): string[] {
  const v = value.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  return v
    ? v
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    : [];
}

export function parseSkill(md: string): SkillMeta & { body: string } {
  const raw: Record<string, string> = {
    name: "",
    description: "",
    tools: "",
    model: "",
  };
  let body = md;
  if (md.startsWith("---")) {
    const rest = md.slice(3);
    const end = rest.indexOf("---");
    if (end !== -1) {
      const fm = rest.slice(0, end);
      body = rest.slice(end + 3);
      for (const line of fm.trim().split("\n")) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        if (k in raw) raw[k] = line.slice(i + 1).trim();
      }
    }
  }
  return {
    name: raw.name,
    description: raw.description,
    tools: parseList(raw.tools),
    model: raw.model || null,
    body: body.trim(),
  };
}

// Validate a skill before saving. Returns an error string, or null when valid.
export function validateSkill(md: string, expectedName: string): string | null {
  const p = parseSkill(md);
  if (!/^[a-z0-9-]+$/.test(expectedName)) return "name must match ^[a-z0-9-]+$";
  if (p.name !== expectedName)
    return `frontmatter name '${p.name}' must equal '${expectedName}'`;
  if (!p.description) return "description is required";
  return null;
}

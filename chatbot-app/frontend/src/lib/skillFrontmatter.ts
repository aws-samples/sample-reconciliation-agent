// Parse/validate a SKILL.md's `--- key: value --- body` frontmatter for the Skills tabs.
//
// The catalog listing here is line-based, but the Lambdas of BOTH apps read the same block with a
// YAML parser (`backend/recon_core/skill_meta.py`, `yaml.safe_load`). A description that is fine as
// a line of text can therefore mean something else, or nothing, to YAML: ` #` starts a comment and
// silently drops the rest of the value, `: ` mid-value or a leading `* & ! @ \` [ { | > % , - ?`
// makes the block invalid and the whole skill is skipped. `validateSkill` refuses those before the
// save so the tab never accepts a skill the agent will then truncate or ignore; a double-quoted
// description reads back verbatim and is always accepted. The rule is written out for authors in
// agent-blueprint/deal-pipeline-agent/README.md ("Skill frontmatter").

export interface SkillMeta {
  name: string;
  description: string;
  // Tools the skill expects the agent to have (frontmatter `tools: [a, b]`).
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

/** Characters that give an unquoted YAML value a meaning other than "this text" when they lead it. */
const YAML_LEADING_INDICATORS = /^[*&!@`[{|>%,'"]|^-(\s|$)|^\?(\s|$)/;

/**
 * Whether an unquoted frontmatter value would be truncated or rejected by the YAML parser the
 * Lambdas use. A value wrapped in matching double or single quotes is a YAML string and is never
 * hazardous here (the parser reads it verbatim); everything else is a plain scalar and must avoid
 * the comment marker, the mapping separator, a tab, and a leading indicator character.
 *
 * @param value the trimmed value as written after `key:`.
 * @returns a short reason, or null when YAML reads the value as the same text.
 */
export function yamlScalarHazard(value: string): string | null {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  if (quoted) return null;
  if (value.includes(" #") || value.startsWith("#"))
    return "contains ' #', which YAML reads as a comment";
  if (value.includes(": ") || value.endsWith(":"))
    return "contains ': ', which YAML reads as a nested key";
  if (value.includes("\t")) return "contains a tab";
  if (YAML_LEADING_INDICATORS.test(value))
    return `starts with '${value[0]}', which YAML reads as syntax`;
  return null;
}

// Validate a skill before saving. Returns an error string, or null when valid.
export function validateSkill(md: string, expectedName: string): string | null {
  const p = parseSkill(md);
  if (!/^[a-z0-9-]+$/.test(expectedName)) return "name must match ^[a-z0-9-]+$";
  if (p.name !== expectedName)
    return `frontmatter name '${p.name}' must equal '${expectedName}'`;
  if (!p.description) return "description is required";
  const hazard = yamlScalarHazard(p.description);
  if (hazard)
    return `description ${hazard}; wrap the description in double quotes`;
  return null;
}

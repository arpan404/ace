import { bareToolName } from "./tool-names.ts";

/**
 * Codex defers every ace tool, and its code-mode models see only `exec` and Codex's own `wait`:
 * they reach ace by filtering the runtime's `ALL_TOOLS` and calling
 * `tools.mcp__ace__<name>(args)` without seeing a schema. Sessions spent several `exec` calls
 * dumping `ALL_TOOLS` before their first ace call, so the developer prefix says how to call ace,
 * which `wait` is ace's, and which tools this session can call. Pure: rendered once per session.
 */

/** About 300 tokens: the name list never outgrows the rest of the prefix. */
export const maxToolNameChars = 1_200;

/** `browser_open` → `browser`; a name without an underscore has no family. */
const familyOf = (name: string) => (name.includes("_") ? name.slice(0, name.indexOf("_")) : "");

/**
 * Bare names, those sharing a family prefix folded into one brace group
 * (`browser_{open,snapshot}`), in catalogue order and cut at a whole entry past the cap.
 */
export function compactToolNames(names: readonly string[], maxChars = maxToolNameChars): string {
  const bare = [...new Set(names.map(bareToolName))];
  const families = new Map<string, string[]>();
  for (const name of bare) {
    const family = familyOf(name);
    if (family) families.set(family, [...(families.get(family) ?? []), name]);
  }
  const entries: string[] = [];
  const folded = new Set<string>();
  for (const name of bare) {
    const family = familyOf(name);
    const members = families.get(family) ?? [];
    if (members.length < 3) entries.push(name);
    else if (!folded.has(family)) {
      folded.add(family);
      const rest = members.map((member) => member.slice(family.length + 1));
      entries.push(`${family}_{${rest.join(",")}}`);
    }
  }
  let text = "";
  for (const entry of entries) {
    const next = text ? `${text}, ${entry}` : entry;
    if (next.length > maxChars) return `${text}, …`;
    text = next;
  }
  return text;
}

/** Codex's line in the developer prefix; `tools` are the names this session can call. */
export function codexPrefix(tools: readonly string[] | undefined, skills: string): string {
  return [
    "Codex: ace tools are mcp__ace__<name>. With exec, call them inside it: await tools.mcp__ace__<name>(args).",
    "ace's wait is tools.mcp__ace__wait, not your own wait.",
    'Find one with ALL_TOOLS.filter(t => t.name.startsWith("mcp__ace__")), or get names and input schemas from tools.mcp__ace__tools_find({query}); guide({topic}) returns its family\'s schemas.',
    tools?.length ? `ace tools here: ${compactToolNames(tools)}.` : undefined,
    skills,
  ]
    .filter(Boolean)
    .join(" ");
}

import {
  ContentPart,
  type CatalogEntry,
  type CatalogInvocation,
  type CatalogMention,
  type CommandResolution,
  type ProviderKind,
  type PromptValue,
} from "@ace/protocol";
import {
  skillContext,
  skillContextBudget,
  skillReference,
  type SkillSource,
} from "./skill-context.ts";

/** Coalesce adjacent text without changing the person's spacing or mention order. */
function append(parts: ContentPart[], part: ContentPart): void {
  const last = parts.at(-1);
  if (part.type === "text" && last?.type === "text") last.text += part.text;
  else parts.push(part.type === "text" ? { ...part } : part);
}

/**
 * Entries whose typed or advertised invocation the provider loads itself. ace's own skill
 * files are unknown to every harness; they and other skills without a native route are
 * injected from their SKILL.md instead.
 */
function native(provider: ProviderKind, entry: CatalogEntry, invocation: CatalogInvocation) {
  if (entry.source.provider === "ace" && invocation.type === "skill") return false;
  if (provider === "codex") return invocation.type === "skill" || invocation.type === "mention";
  if (provider === "opencode")
    return (
      invocation.type === "skill" || invocation.type === "agent" || invocation.type === "slash"
    );
  // Claude Code, Pi and ACP agents expand an advertised `/name` at the start of a prompt.
  if (["acp", "antigravity", "pi", "claude"].includes(provider)) return invocation.type === "slash";
  return false;
}

export function translateMentions(
  input: readonly ContentPart[],
  provider: ProviderKind,
  entries: readonly CatalogEntry[],
  resolve: (
    id: string,
    positional: string[],
    values: Record<string, PromptValue>,
  ) => CommandResolution,
  skill: (entry: CatalogEntry) => SkillSource | undefined = () => undefined,
): ContentPart[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const output: ContentPart[] = [];
  const skills: string[] = [];
  let skillBytes = 0;
  for (const part of input) {
    if (part.type !== "mention") {
      append(output, part);
      continue;
    }
    const entry = byId.get(part.entryId);
    if (!entry || (entry.source.provider !== "ace" && entry.source.provider !== provider))
      throw new Error("catalog_mention_unavailable");
    const invocation = entry.invocation;
    if (invocation.type === "unavailable" || invocation.type === "action")
      throw new Error("catalog_mention_requires_action");
    const selected: CatalogMention = {
      ...part,
      name: entry.name,
      kind: entry.kind,
      invocation,
      ...(entry.icon ? { icon: entry.icon } : {}),
    };
    if (native(provider, entry, invocation)) {
      // Codex documents the `$name` marker alongside the typed item for explicit invocation.
      if (provider === "codex" && invocation.type === "skill")
        append(output, { type: "text", text: `$${invocation.name}` });
      output.push(selected);
      if (provider === "codex" && part.arguments)
        append(output, {
          type: "text",
          text: `[Arguments for ${JSON.stringify(invocation.type === "skill" || invocation.type === "mention" ? invocation.name : entry.name)}: ${part.arguments}]`,
        });
      continue;
    }
    // Parameterized ace skills expand through the prompt owner, which inlines their body.
    if (entry.kind === "skill" && invocation.type !== "prompt") {
      const source = skill(entry);
      if (source) {
        const block = skillContext(source, part.arguments);
        skillBytes += Buffer.byteLength(block);
        if (skillBytes > skillContextBudget) throw new Error("catalog_skill_too_large");
        skills.push(block);
        append(output, { type: "text", text: skillReference(entry.name) });
        continue;
      }
      // Without a readable SKILL.md only the harness can load the skill; never send bare text.
      if (invocation.type !== "slash" || provider !== "cursor")
        throw new Error("catalog_skill_unavailable");
    }
    let text: string;
    if (invocation.type === "prompt") {
      const resolution = resolve(
        invocation.commandId,
        part.arguments ? [part.arguments] : [],
        part.values ?? {},
      );
      if (!resolution.ok || resolution.plan.kind !== "prompt")
        throw new Error("catalog_prompt_unavailable");
      text = resolution.plan.text;
    } else if (invocation.type === "plugin")
      text = `[Use the enabled ${JSON.stringify(invocation.name)} plugin and its skills and tools${part.arguments ? `: ${part.arguments}` : ""}]`;
    else if (invocation.type === "agent")
      text = `[Delegate to the ${JSON.stringify(invocation.name)} agent${part.arguments ? `: ${part.arguments}` : ""}]`;
    else if (invocation.type === "tool")
      text = `[Use the ${JSON.stringify(invocation.name)} tool from MCP server ${JSON.stringify(invocation.server)}${part.arguments ? `: ${part.arguments}` : ""}]`;
    else if (provider === "cursor" && entry.kind === "skill" && invocation.type === "slash")
      text = `[Use the ${JSON.stringify(invocation.name)} skill${part.arguments ? `: ${part.arguments}` : ""}]`;
    else if (invocation.type === "slash")
      text = `/${invocation.name}${part.arguments ? ` ${part.arguments}` : ""}`;
    else throw new Error("catalog_skill_unavailable");
    append(output, { type: "text", text });
  }
  if (skills.length) output.unshift({ type: "text", text: `${skills.join("\n\n")}\n\n` });
  const merged: ContentPart[] = [];
  for (const part of output) append(merged, part);
  return ContentPart.array().max(256).parse(merged);
}

import {
  ContentPart,
  type CatalogEntry,
  type CatalogMention,
  type CommandResolution,
  type ProviderKind,
  type PromptValue,
} from "@ace/protocol";

/** Coalesce adjacent text without changing the person's spacing or mention order. */
function append(parts: ContentPart[], part: ContentPart): void {
  const last = parts.at(-1);
  if (part.type === "text" && last?.type === "text") last.text += part.text;
  else parts.push(part.type === "text" ? { ...part } : part);
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
): ContentPart[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const output: ContentPart[] = [];
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
    if (
      (["acp", "antigravity", "pi"].includes(provider) && invocation.type === "slash") ||
      (provider === "opencode" &&
        (invocation.type === "skill" ||
          invocation.type === "agent" ||
          invocation.type === "slash")) ||
      (provider === "codex" && (invocation.type === "skill" || invocation.type === "mention"))
    ) {
      output.push(selected);
      if (provider === "codex" && part.arguments)
        append(output, {
          type: "text",
          text: `[Arguments for ${JSON.stringify(invocation.name)}: ${part.arguments}]`,
        });
      continue;
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
    else if (provider === "claude" && invocation.type === "slash")
      text = `[Use the Skill tool with skill=${JSON.stringify(invocation.name)}${part.arguments ? ` and args=${JSON.stringify(part.arguments)}` : ""}]`;
    else if (invocation.type === "slash")
      text = `/${invocation.name}${part.arguments ? ` ${part.arguments}` : ""}`;
    else
      text = `[Use skill ${JSON.stringify(invocation.name)} at ${JSON.stringify(invocation.path)}${part.arguments ? `: ${part.arguments}` : ""}]`;
    append(output, { type: "text", text });
  }
  return ContentPart.array().max(256).parse(output);
}

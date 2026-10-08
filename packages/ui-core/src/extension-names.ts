import type { CatalogEntry } from "@ace/protocol";

const human = (value: string) =>
  value
    .replace(/[-_]+/g, " ")
    .replace(
      /(^|[^\p{L}\p{N}])(\p{L})/gu,
      (_match, before: string, letter: string) => before + letter.toUpperCase(),
    );

/** Names for people; qualified invocation names remain unchanged for the provider. */
export function extensionDisplayName(name: string, title?: string, agentPlugin?: string): string {
  const text = title?.trim() || name.split(":").at(-1) || name;
  return [agentPlugin && human(agentPlugin), human(text)].filter(Boolean).join(" ");
}

export function catalogDisplayName(
  entry: Pick<CatalogEntry, "name" | "title" | "kind" | "source">,
): string {
  const plugin =
    entry.source.plugin ?? (entry.name.includes(":") ? entry.name.split(":")[0] : undefined);
  return entry.kind === "builtin"
    ? entry.name
    : extensionDisplayName(entry.name, entry.title, entry.kind === "agent" ? plugin : undefined);
}

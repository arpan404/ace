import type { CatalogEntry, ProviderKind } from "@ace/protocol";
export function mergeExtensions(
  local: CatalogEntry[],
  advertised: CatalogEntry[],
  native: ReadonlySet<string> = new Set(),
): CatalogEntry[] {
  const merged = new Map<string, CatalogEntry>();
  for (const entry of [...local, ...advertised]) {
    const key = `${entry.source.provider}:${entry.kind}:${entry.invocation.type === "skill" ? entry.invocation.name : entry.name}`;
    const old = merged.get(key);
    if (old && (old.invocation.type === "unavailable" || native.has(old.id))) continue;
    if (!old || old.source.scope !== "project" || entry.source.scope === "project")
      merged.set(key, entry);
  }
  return [...merged.values()];
}
export function filterExtensions(
  entries: CatalogEntry[],
  query: string,
  limit: number,
  provider: ProviderKind,
): CatalogEntry[] {
  const q = query.toLowerCase().replace(/^\//, "");
  return boundExtensions(
    [...entries, ...addActions(provider)].filter(
      (entry) => !q || `${entry.name} ${entry.description}`.toLowerCase().includes(q),
    ),
    limit,
  );
}
export function boundExtensions(entries: CatalogEntry[], limit = 512): CatalogEntry[] {
  const output: CatalogEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > 512 * 1024) break;
    output.push(entry);
    bytes += size;
    if (output.length >= Math.min(512, Math.max(1, limit))) break;
  }
  return output;
}
function addActions(provider: ProviderKind): CatalogEntry[] {
  return [
    ["attach", "Attach files", "Add files and images"],
    ["files", "Files and folders", "Reference workspace files"],
    ["project", "Work in a project", "Choose a project"],
    ["plan", "Plan mode", "Review a plan before editing"],
    ["goal", "Goal", "Set a goal for this thread"],
  ]
    .filter(([id]) =>
      id === "plan"
        ? ["claude", "codex"].includes(provider)
        : id === "goal"
          ? provider === "codex"
          : true,
    )
    .map(([id = "", name = "", description = ""]) => ({
      id: `ace:add:${id}`,
      kind: "builtin",
      name,
      description,
      source: { provider: "ace", scope: "ace" },
      invocation: { type: "action", action: id },
    }));
}

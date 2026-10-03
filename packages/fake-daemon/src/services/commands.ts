import { PaletteCommand, type ProviderKind } from "@ace/protocol";

const entry = (
  name: string,
  description: string,
  namespace: PaletteCommand["namespace"],
  provider: ProviderKind | "any",
  argumentHint?: string,
): PaletteCommand =>
  PaletteCommand.parse({
    id: `${namespace}:${name}`,
    name,
    description,
    namespace,
    provider,
    arguments: {},
    scope: namespace === "prompt" ? "workspace" : namespace === "ace" ? "builtin" : "runtime",
    ...(argumentHint ? { argumentHint } : {}),
  });

/** What `commands.list` offers in a thread: provider commands, prompt files and ace's own. */
export function commandCatalog(): PaletteCommand[] {
  return [
    entry("review", "Review the changes on this branch", "provider", "any"),
    entry("test", "Run the tests and fix what fails", "prompt", "any", "path"),
    entry("plan", "Plan before editing; ask me to approve", "provider", "any"),
    entry("compact", "Summarise the conversation to free context", "provider", "any"),
    entry("init", "Write an AGENTS.md for this project", "provider", "any"),
    entry("pr", "Open a pull request for this branch", "prompt", "any"),
    entry("fork", "Continue in a new thread from here", "ace", "any"),
  ];
}

/** Prefix matches first, then matches anywhere in the name, as the daemon ranks them. */
export function listCommands(
  catalog: readonly PaletteCommand[],
  provider: ProviderKind | undefined,
  query: string,
  limit: number,
): PaletteCommand[] {
  const q = query.toLowerCase().replace(/^\//, "");
  const usable = catalog.filter((c) => c.provider === "any" || c.provider === provider);
  const prefix = usable.filter((c) => c.name.startsWith(q));
  const inner = usable.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...inner].slice(0, limit);
}

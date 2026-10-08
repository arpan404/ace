import { z } from "zod";
import { runtimeExtensions } from "./extension-runtime.ts";
import { dataWeight } from "./limits.ts";
import type {
  PaletteCommand,
  CommandResolution,
  CommandDiagnostic,
  ProviderKind,
  CatalogEntry,
} from "@ace/protocol";
import { metadata, type Definition, type ParsedSource, type Target } from "./types.ts";
import { resolveCommand } from "./plan.ts";
import { parseRuntime } from "./runtime.ts";
import { searchCommands, type Usage } from "./search.ts";
export class CommandCatalog {
  private readonly sources = new Map<string, ParsedSource>();
  private readonly entries = new Map<string, Definition>();
  private readonly usage = new Map<string, Usage>();
  private retainedBytes = 0;
  private readonly weights = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
    this.replaceSource("ace", { commands: builtins(), diagnostics: [] });
  }
  /** Replace exactly one source; rejected admission leaves the previous version intact. */
  replaceSource(source: string, parsed: ParsedSource): boolean {
    const old = this.sources.get(source);
    if (parsed.commands.length > 512) return false;
    const commands = [...new Map(parsed.commands.map((command) => [command.id, command])).values()];
    let weight = 0;
    for (const command of commands) {
      const rawWeight = dataWeight(command.raw);
      if (rawWeight === undefined) return false;
      weight +=
        Buffer.byteLength(command.body) +
        rawWeight +
        4096 +
        (command.extension ? Buffer.byteLength(JSON.stringify(command.extension)) : 0);
    }
    const nextBytes = this.retainedBytes - (this.weights.get(source) ?? 0) + weight;
    if (
      (!old && this.sources.size >= 2048) ||
      this.entries.size - (old?.commands.length ?? 0) + commands.length > 4096 ||
      nextBytes > 8 * 1024 * 1024
    )
      return false;
    this.retainedBytes = nextBytes;
    this.weights.set(source, weight);
    if (old) for (const command of old.commands) this.entries.delete(command.id);
    this.sources.set(source, {
      commands,
      diagnostics: parsed.diagnostics.slice(0, 100),
    });
    for (const command of commands) this.entries.set(command.id, command);
    return true;
  }
  removeSource(source: string): void {
    const old = this.sources.get(source);
    if (old)
      for (const command of old.commands) {
        this.entries.delete(command.id);
        this.usage.delete(command.id);
      }
    this.sources.delete(source);
    this.retainedBytes -= this.weights.get(source) ?? 0;
    this.weights.delete(source);
  }
  updateRuntime(target: Target, input: unknown): boolean {
    const extensions = runtimeExtensions(input, target);
    if (extensions) return this.replaceSource(extensions.source, extensions.parsed);
    const parsed = parseRuntime(input, target);
    // Malformed replacements must not erase a working catalog.
    if (!parsed.commands.length && parsed.diagnostics.length) return false;
    const source = `runtime:${target.session}`;
    const old = this.sources.get(source);
    const nativeMetadata = z
      .object({
        plugins: z.unknown().optional(),
        tools: z.unknown().optional(),
        mcp_servers: z.unknown().optional(),
      })
      .safeParse(input);
    if (target.provider === "claude" && old && nativeMetadata.success) {
      const oldSkills = new Map(
        old.commands
          .filter((d) => d.extension?.kind === "skill")
          .map((d) => [d.nativeName, d.extension]),
      );
      for (const command of parsed.commands) {
        const skill = oldSkills.get(command.nativeName);
        if (!command.extension && skill)
          command.extension = { ...skill, description: command.description || skill.description };
      }
      for (const command of old.commands) {
        const kind = command.extension?.kind;
        if (
          (kind === "plugin" &&
            (command.extension?.invocation.type === "unavailable"
              ? nativeMetadata.data.mcp_servers
              : nativeMetadata.data.plugins) === undefined) ||
          (kind === "mcp-tool" && nativeMetadata.data.tools === undefined)
        )
          parsed.commands.push(command);
      }
    }
    return this.replaceSource(source, parsed);
  }
  clearRuntime(session: string): void {
    for (const source of this.sources.keys())
      if (source === `runtime:${session}` || source.startsWith(`runtime:${session}:`))
        this.removeSource(source);
  }
  private visible(target: Target): Map<string, Definition> {
    const winners = new Map<string, Definition>();
    for (const d of this.entries.values()) {
      if (
        (d.provider !== "any" && d.provider !== target.provider) ||
        (d.instance !== undefined && d.instance !== target.instance) ||
        (d.session !== undefined && d.session !== target.session)
      )
        continue;
      const key = `${d.namespace}:${d.extension && !["skill", "command"].includes(d.extension.kind) ? d.extension.kind : "command"}:${d.nativeName}`;
      const old = winners.get(key);
      if (
        !old ||
        d.priority > old.priority ||
        (d.priority === old.priority && d.id.localeCompare(old.id) < 0)
      )
        winners.set(key, d);
    }
    return winners;
  }
  list(
    target: Target,
    query = "",
    limit = 50,
  ): { commands: PaletteCommand[]; diagnostics: CommandDiagnostic[] } {
    const commands = Array.from(this.visible(target).values()).filter(
      (d) =>
        !d.unavailable &&
        (!d.extension || d.extension.kind === "command" || d.extension.kind === "skill"),
    );
    const diagnostics: CommandDiagnostic[] = [];
    for (const source of this.sources.values()) {
      diagnostics.push(...source.diagnostics.slice(0, 100 - diagnostics.length));
      if (diagnostics.length >= 100) break;
    }
    return {
      commands: searchCommands(commands, query.slice(0, 256), limit, this.usage, this.now()).map(
        metadata,
      ),
      diagnostics,
    };
  }
  extensions(target: Target): import("@ace/protocol").CatalogEntry[] {
    return this.extensionSnapshot(target).entries;
  }
  extensionSnapshot(target: Target): {
    entries: import("@ace/protocol").CatalogEntry[];
    native: Set<string>;
  } {
    const native = new Set<string>();
    const files = new Map<string, Definition>();
    for (const file of this.entries.values())
      if (file.format !== "runtime" && file.instance === target.instance && file.extension) {
        const key = `${["skill", "command"].includes(file.extension.kind) ? "command" : file.extension.kind}:${file.nativeName}`;
        const old = files.get(key);
        if (!old || file.priority > old.priority) files.set(key, file);
      }
    const entries = Array.from(this.visible(target).values())
      .filter((d) => !d.unavailable)
      .map((d): CatalogEntry => {
        const kind = d.extension?.kind ?? "command";
        const source = `runtime:${target.session}`;
        const advertised =
          (((target.provider === "claude" && (kind === "skill" || kind === "command")) ||
            (kind === "command" &&
              ["opencode", "pi", "acp", "antigravity"].includes(target.provider))) &&
            this.sources.has(source)) ||
          (kind === "skill" &&
            (this.sources.has(`${source}:skills-list`) ||
              this.sources.has(`${source}:skill-list`))) ||
          (kind === "agent" && this.sources.has(`${source}:agent-list`));
        if (d.format !== "runtime" && d.extension && d.provider !== "any" && advertised)
          return Object.assign({}, d.extension, {
            invocation: {
              type: "unavailable" as const,
              reason: "Not advertised by the active provider session",
            },
          });
        const fileKey = `${["skill", "command"].includes(kind) ? "command" : kind}:${d.nativeName}`;
        const inherited = d.format === "runtime" ? files.get(fileKey) : undefined;
        if (d.format === "runtime")
          native.add(
            inherited?.extension && (!d.extension || d.extension.kind === inherited.extension.kind)
              ? inherited.extension.id
              : (d.extension?.id ?? d.id),
          );
        if (inherited?.extension && (!d.extension || d.extension.kind === inherited.extension.kind))
          return Object.assign({}, inherited.extension, d.extension, {
            id: inherited.extension.id,
            description: d.description || inherited.description,
            source: inherited.extension.source,
            invocation: d.extension?.invocation ?? { type: "slash" as const, name: d.nativeName },
          });
        return (
          d.extension ?? {
            id: d.id,
            kind: d.format === "ace" ? "builtin" : "command",
            name: d.name,
            description: d.description,
            source: {
              provider: d.provider === "any" ? "ace" : d.provider,
              scope: d.format === "ace" ? "ace" : d.scope === "workspace" ? "project" : "global",
            },
            invocation:
              d.format === "ace"
                ? { type: "action", action: d.name }
                : d.format === "library" || d.format === "codex"
                  ? { type: "prompt", commandId: d.id }
                  : { type: "slash", name: d.nativeName },
          }
        );
      });
    return { entries, native };
  }
  resolve(
    target: Target,
    id: string,
    args: unknown = {},
    positional: unknown = [],
  ): CommandResolution {
    const command = this.entries.get(id);
    if (
      !command ||
      !Array.from(this.visible(target).values()).some((d) => d.id === id) ||
      (command.instance !== undefined && command.instance !== target.instance) ||
      (command.session !== undefined && command.session !== target.session)
    )
      return { ok: false, error: "not_found" };
    return resolveCommand(command, args, positional, target.provider);
  }
  recordUse(id: string): void {
    if (!this.entries.has(id)) return;
    const old = this.usage.get(id);
    this.usage.delete(id);
    this.usage.set(id, { count: Math.min(1000000, (old?.count ?? 0) + 1), last: this.now() });
    if (this.usage.size > 1024) {
      const first = this.usage.keys().next().value;
      if (first !== undefined) this.usage.delete(first);
    }
  }
}
function builtins(): Definition[] {
  const descriptions: Record<string, string> = {
    review: "Review changes",
    fork: "Fork this thread",
    checkpoint: "Save a checkpoint",
    model: "Choose a model",
  };
  return Object.entries(descriptions).map(([name, description]) => ({
    id: `ace#${name}`,
    name,
    nativeName: name,
    description,
    namespace: "ace",
    provider: "any" as const,
    arguments: name === "model" ? { model: { type: "string" as const, required: false } } : {},
    scope: "builtin" as const,
    body: "",
    format: "ace" as const,
    raw: {},
    priority: 0,
  }));
}
export interface CommandService {
  invalidateExtras?(): void;
  listCatalog?(
    thread: string,
    query: string,
    limit: number,
  ): Promise<{ entries: import("@ace/protocol").CatalogEntry[]; stale: boolean }>;
  listCatalogWorkspace?(
    context: import("./types.ts").LibraryContext,
    query: string,
    limit: number,
  ): Promise<{ entries: import("@ace/protocol").CatalogEntry[]; stale: boolean }>;
  listCatalogDraft?(
    draft: string,
    context: import("./types.ts").LibraryContext,
    query: string,
    limit: number,
  ): Promise<{ entries: import("@ace/protocol").CatalogEntry[]; stale: boolean }>;
  subscribeCatalog?(listener: () => void): () => void;
  prepareMentions?(
    thread: string,
    input: readonly import("@ace/protocol").ContentPart[],
  ): Promise<import("@ace/protocol").ContentPart[]>;
  listDraft?(
    draft: string,
    context: import("./types.ts").LibraryContext,
    query: string,
    limit: number,
  ): Promise<{ commands: PaletteCommand[]; diagnostics: CommandDiagnostic[] }>;
  list(
    threadId: string,
    query: string,
    limit: number,
  ): Promise<{ commands: PaletteCommand[]; diagnostics: CommandDiagnostic[] }>;
  resolve(
    threadId: string,
    id: string,
    args: unknown,
    positional: unknown,
  ): Promise<CommandResolution>;
}
export interface ProviderInstance {
  id: string;
  provider: ProviderKind;
  home: string;
  skillsHome?: string | undefined;
}

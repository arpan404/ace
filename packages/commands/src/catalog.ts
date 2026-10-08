import { dataWeight } from "./limits.ts";
import type {
  PaletteCommand,
  CommandResolution,
  CommandDiagnostic,
  ProviderKind,
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
      weight += Buffer.byteLength(command.body) + rawWeight + 4096;
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
    const parsed = parseRuntime(input, target);
    // Malformed replacements must not erase a working catalog.
    if (!parsed.commands.length && parsed.diagnostics.length) return false;
    return this.replaceSource(`runtime:${target.session}`, parsed);
  }
  clearRuntime(session: string): void {
    this.removeSource(`runtime:${session}`);
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
      const key = `${d.namespace}:${d.name}`;
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
    const commands = Array.from(this.visible(target).values()).filter((d) => !d.unavailable);
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
  resolve(
    target: Target,
    id: string,
    args: unknown = {},
    positional: unknown = [],
  ): CommandResolution {
    const command = this.entries.get(id);
    if (
      !command ||
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
}

import { z } from "zod";
import { ProviderKind, type CommandResolution } from "@ace/protocol";
import { CommandCatalog, type CommandService, type ProviderInstance } from "./catalog.ts";
import { CommandFiles, discoveryRoots } from "./files.ts";
const context = z.object({
  workspace: z.string().min(1),
  provider: ProviderKind,
  instance: z.string().min(1).max(128),
});
export interface LibraryContext {
  workspace: string;
  provider: ProviderKind;
  instance: string;
}
interface Entry {
  runtime: Set<string>;
  catalog: CommandCatalog;
  files: CommandFiles;
}
/** Owns a bounded set of workspace/instance catalogs. Context comes from a trusted thread registry. */
export class CommandLibrary implements CommandService {
  private readonly entries = new Map<string, Entry>();
  private readonly contexts: (thread: string) => unknown;
  private readonly instances: ProviderInstance[];
  private readonly aceHome: string;
  private readonly now: () => number;
  private serial: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  constructor(options: {
    context(thread: string): unknown;
    instances: readonly ProviderInstance[];
    aceHome: string;
    now: () => number;
  }) {
    this.contexts = options.context;
    this.aceHome = options.aceHome;
    this.now = options.now;
    this.instances = z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          provider: ProviderKind,
          home: z.string().min(1),
        }),
      )
      .max(32)
      .parse(options.instances);
    if (new Set(this.instances.map((i) => i.id)).size !== this.instances.length)
      throw new Error("Duplicate provider instance");
  }
  private async get(thread: string): Promise<{
    entry: Entry;
    target: { provider: LibraryContext["provider"]; instance: string; session: string };
  }> {
    const ctx = context.parse(this.contexts(thread));
    const instance = this.instances.find(
      (i) => i.id === ctx.instance && i.provider === ctx.provider,
    );
    if (!instance) throw new Error("Unknown provider instance");
    const key = `${ctx.workspace}\0${ctx.instance}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 8) {
        const first = Array.from(this.entries).find(([, value]) => value.runtime.size === 0)?.[0];
        if (first === undefined) throw new Error("Active command contexts limit exceeded");
        if (first !== undefined) {
          await this.entries.get(first)?.files.close();
          this.entries.delete(first);
        }
      }
      const catalog = new CommandCatalog(this.now);
      const files = new CommandFiles(
        catalog,
        discoveryRoots([instance], this.aceHome, ctx.workspace),
      );
      entry = { catalog, files, runtime: new Set() };
      this.entries.set(key, entry);
      try {
        await files.start();
      } catch (error) {
        await files.close();
        this.entries.delete(key);
        throw error;
      }
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return { entry, target: { provider: ctx.provider, instance: ctx.instance, session: thread } };
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.pending >= 16)
      return Promise.reject(new Error("Command service admission limit"));
    this.pending++;
    const run = this.serial.then(work);
    this.serial = run.catch(() => {});
    return run.finally(() => {
      this.pending--;
    });
  }
  list(thread: string, query: string, limit: number) {
    return this.enqueue(async () => {
      const { entry, target } = await this.get(thread);
      return entry.catalog.list(target, query, limit);
    });
  }
  resolve(
    thread: string,
    id: string,
    args: unknown,
    positional: unknown,
  ): Promise<CommandResolution> {
    return this.enqueue(async () => {
      const { entry, target } = await this.get(thread);
      return entry.catalog.resolve(target, id, args, positional);
    });
  }
  updateRuntime(thread: string, frame: unknown): Promise<boolean> {
    return this.enqueue(async () => {
      const { entry, target } = await this.get(thread);
      const accepted = entry.catalog.updateRuntime(target, frame);
      if (accepted) entry.runtime.add(thread);
      return accepted;
    });
  }
  clearRuntime(thread: string): void {
    for (const entry of this.entries.values()) {
      entry.catalog.clearRuntime(thread);
      entry.runtime.delete(thread);
    }
  }
  recordUse(thread: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      const { entry } = await this.get(thread);
      entry.catalog.recordUse(id);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.serial;
    for (const entry of this.entries.values()) await entry.files.close();
    this.entries.clear();
  }
}

import { watchCatalogMetadata } from "./metadata-watch.ts";
import { boundExtensions, filterExtensions, mergeExtensions } from "./extension-view.ts";
import { loadedPluginRoots, installedPluginRoots } from "./plugin-roots.ts";
import type { DiscoveryRoot } from "./roots.ts";
import { translateMentions } from "./mentions.ts";
import type { CatalogEntry, ContentPart } from "@ace/protocol";
import type { LibraryContext } from "./types.ts";
import { z } from "zod";
import { ProviderKind, type CommandResolution } from "@ace/protocol";
import { CommandCatalog, type CommandService, type ProviderInstance } from "./catalog.ts";
import { CommandFiles } from "./files.ts";
import { discoveryRoots } from "./roots.ts";
const context = z.object({
  workspace: z.string().min(1).max(4096),
  provider: ProviderKind,
  instance: z.string().min(1).max(128),
});

interface Entry {
  stopMetadata(): void;
  extras: CatalogEntry[];
  extrasAt: number;
  refreshing?: Promise<void> | undefined;
  pluginFiles?: { key: string; files: CommandFiles; ready: Promise<void>; pending: boolean };
  nativePluginRoots?: DiscoveryRoot[];
  pluginsSerial?: Promise<void>;
  ready: Promise<void>;
  stale: boolean;
  runtime: Set<string>;
  catalog: CommandCatalog;
  files: CommandFiles;
}
/** Owns a bounded set of workspace/instance catalogs. Context comes from a trusted thread registry. */
export class CommandLibrary implements CommandService {
  private readonly entries = new Map<string, Entry>();
  private readonly contexts: (thread: string) => unknown;
  private readonly instances: () => readonly ProviderInstance[];
  private readonly extras: ((context: LibraryContext) => Promise<CatalogEntry[]>) | undefined;
  private readonly aceHome: string;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private readonly updates = new Map<string, Set<{ cancelled: boolean }>>();
  constructor(options: {
    context(thread: string): unknown;
    instances: readonly ProviderInstance[] | (() => readonly ProviderInstance[]);
    aceHome: string;
    now: () => number;
    extras?: (context: LibraryContext) => Promise<CatalogEntry[]>;
  }) {
    this.extras = options.extras;
    this.contexts = options.context;
    this.aceHome = z.string().min(1).max(4096).parse(options.aceHome);
    this.now = options.now;
    const instances = options.instances;
    this.instances = typeof instances === "function" ? instances : () => instances;
    this.readInstances();
  }
  private readInstances(): ProviderInstance[] {
    const instances = z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          provider: ProviderKind,
          home: z.string().min(1).max(4096),
          skillsHome: z.string().min(1).max(4096).optional(),
        }),
      )
      // The account registry admits 256 accounts, alongside seven legacy CLI identities.
      .max(263)
      .parse(this.instances());
    if (new Set(instances.map((i) => i.id)).size !== instances.length)
      throw new Error("Duplicate provider instance");
    return instances;
  }

  private async get(thread: string): Promise<{
    entry: Entry;
    target: { provider: LibraryContext["provider"]; instance: string; session: string };
  }> {
    return this.getContext(thread, context.parse(this.contexts(thread)));
  }
  private async getContext(
    thread: string,
    ctx: LibraryContext,
  ): Promise<{
    entry: Entry;
    target: { provider: LibraryContext["provider"]; instance: string; session: string };
  }> {
    const instance = this.readInstances().find(
      (i) => i.id === ctx.instance && i.provider === ctx.provider,
    );
    const key = `${ctx.workspace}\0${ctx.provider}\0${ctx.instance}\0${instance?.home ?? ""}\0${instance?.skillsHome ?? ""}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 8) {
        const first = Array.from(this.entries).find(([, value]) => value.runtime.size === 0)?.[0];
        if (first === undefined) throw new Error("Active command contexts limit exceeded");
        if (first !== undefined) {
          const evicted = this.entries.get(first);
          evicted?.stopMetadata();
          await evicted?.refreshing;
          await evicted?.files.close();
          await evicted?.pluginFiles?.files.close();
          this.entries.delete(first);
        }
      }
      const catalog = new CommandCatalog(this.now);
      const files = new CommandFiles(
        catalog,
        discoveryRoots(instance ? [instance] : [], this.aceHome, ctx.workspace),
      );
      entry = {
        catalog,
        files,
        stopMetadata: () => {},
        runtime: new Set(),
        stale: true,
        extras: [],
        extrasAt: -Infinity,
        ready: Promise.resolve(),
      };
      const created = entry;
      created.stopMetadata = watchCatalogMetadata(instance, ctx.workspace, () => {
        created.extrasAt = -Infinity;
        this.notify();
      });
      files.subscribe(() => {
        created.extrasAt = -Infinity;
        this.notify();
      });
      created.ready = files
        .start()
        .then(() => {
          created.stale = false;
          this.notify();
        })
        .catch(() => {
          created.stale = true;
        });
      this.entries.set(key, entry);
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    this.refreshExtras(entry, ctx);
    return { entry, target: { provider: ctx.provider, instance: ctx.instance, session: thread } };
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.pending >= 80)
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
      await entry.ready;
      return entry.catalog.list(target, query, limit);
    });
  }
  /** File and builtin commands only, without starting a provider or retaining a draft. */
  listDraft(draft: string, input: LibraryContext, query: string, limit: number) {
    return this.enqueue(async () => {
      const parsed = context.parse(input);
      const selected =
        parsed.instance === parsed.provider
          ? (this.readInstances().find((instance) => instance.provider === parsed.provider)?.id ??
            parsed.instance)
          : parsed.instance;
      const { entry, target } = await this.getContext(`draft:${draft}`, {
        ...parsed,
        instance: selected,
      });
      await entry.ready;
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
      await entry.ready;
      return entry.catalog.resolve(target, id, args, positional);
    });
  }
  updateRuntime(thread: string, frame: unknown): Promise<boolean> {
    if (this.closed || this.pending >= 80)
      return Promise.reject(new Error("Command service admission limit"));
    const token = { cancelled: false };
    let tokens = this.updates.get(thread);
    if (!tokens) this.updates.set(thread, (tokens = new Set()));
    tokens.add(token);
    return this.enqueue(async () => {
      if (token.cancelled) return false;
      const { entry, target } = await this.get(thread);
      if (token.cancelled) return false;
      const accepted = entry.catalog.updateRuntime(target, frame);
      const roots =
        target.provider === "claude" ? loadedPluginRoots(frame, target.instance) : undefined;
      if (roots) {
        entry.nativePluginRoots = roots;
        await this.setPluginRoots(entry, target.instance);
      }
      if (accepted) {
        entry.extrasAt = this.now();
        entry.runtime.add(thread);
        this.notify();
      }
      return accepted;
    }).finally(() => {
      tokens.delete(token);
      if (!tokens.size) this.updates.delete(thread);
    });
  }
  clearRuntime(thread: string): void {
    for (const token of this.updates.get(thread) ?? []) token.cancelled = true;
    for (const entry of this.entries.values()) {
      entry.catalog.clearRuntime(thread);
      entry.runtime.delete(thread);
      this.notify();
    }
  }
  invalidateExtras(): void {
    for (const entry of this.entries.values()) entry.extrasAt = -Infinity;
    this.notify();
  }
  private refreshExtras(entry: Entry, ctx: LibraryContext): void {
    if (!this.extras || entry.refreshing || this.now() - entry.extrasAt < 30_000) return;
    entry.extrasAt = this.now();
    entry.refreshing = this.extras(ctx)
      .then(async (entries) => {
        entry.extras = boundExtensions(entries);
        await this.setPluginRoots(entry, ctx.instance);
        this.notify();
      })
      .catch(() => {})
      .finally(() => {
        entry.refreshing = undefined;
        this.notify();
      });
  }
  private setPluginRoots(entry: Entry, instance: string): Promise<void> {
    const work = (entry.pluginsSerial ?? Promise.resolve()).then(() =>
      this.replacePluginRoots(entry, instance),
    );
    entry.pluginsSerial = work.catch(() => {});
    return work;
  }
  private async replacePluginRoots(entry: Entry, instance: string): Promise<void> {
    const roots = [
      ...new Map(
        [...(entry.nativePluginRoots ?? []), ...installedPluginRoots(entry.extras, instance)].map(
          (root) => [root.path, root],
        ),
      ).values(),
    ].slice(0, 32);
    const key = JSON.stringify(roots);
    if ((!roots.length && !entry.pluginFiles) || entry.pluginFiles?.key === key) return;
    await entry.pluginFiles?.files.remove();
    const files = new CommandFiles(entry.catalog, roots);
    files.subscribe(() => {
      entry.extrasAt = -Infinity;
      this.notify();
    });
    const discovery = {
      key,
      files,
      pending: true,
      ready: Promise.resolve(),
    };
    entry.pluginFiles = discovery;
    discovery.ready = files
      .start()
      .then(() => {
        discovery.pending = false;
        this.notify();
      })
      .catch(() => {
        discovery.pending = false;
        this.notify();
      });
  }
  subscribeCatalog(listener: () => void): () => void {
    if (this.closed || this.listeners.size >= 64) throw new Error("Catalog subscription limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A disconnected client cannot stop discovery. */
      }
    }
  }
  listCatalog(thread: string, query = "", limit = 100) {
    return this.enqueue(async () => {
      const { entry, target } = await this.get(thread);
      const snapshot = entry.catalog.extensionSnapshot(target);
      return {
        entries: filterExtensions(
          mergeExtensions(snapshot.entries, entry.extras, snapshot.native),
          query,
          limit,
          target.provider,
        ),
        stale: entry.stale || entry.refreshing !== undefined || entry.pluginFiles?.pending === true,
      };
    });
  }
  listCatalogDraft(draft: string, input: LibraryContext, query = "", limit = 100) {
    return this.readContextCatalog(`draft:${draft}`, input, query, limit);
  }
  listCatalogWorkspace(input: LibraryContext, query = "", limit = 100) {
    return this.readContextCatalog("workspace-catalog", input, query, limit);
  }
  private readContextCatalog(owner: string, input: LibraryContext, query: string, limit: number) {
    return this.enqueue(async () => {
      const parsed = context.parse(input);
      const selected =
        parsed.instance === parsed.provider
          ? (this.readInstances().find((i) => i.provider === parsed.provider)?.id ??
            parsed.instance)
          : parsed.instance;
      const { entry, target } = await this.getContext(owner, {
        ...parsed,
        instance: selected,
      });
      const snapshot = entry.catalog.extensionSnapshot(target);
      return {
        entries: filterExtensions(
          mergeExtensions(snapshot.entries, entry.extras, snapshot.native),
          query,
          limit,
          target.provider,
        ),
        stale: entry.stale || entry.refreshing !== undefined || entry.pluginFiles?.pending === true,
      };
    });
  }
  prepareMentions(thread: string, input: readonly ContentPart[]): Promise<ContentPart[]> {
    return this.enqueue(async () => {
      const { entry, target } = await this.get(thread);
      await entry.ready;
      await entry.refreshing;
      await entry.pluginFiles?.ready;
      const snapshot = entry.catalog.extensionSnapshot(target);
      return translateMentions(
        input,
        target.provider,
        mergeExtensions(snapshot.entries, entry.extras, snapshot.native),
        (id, positional, values) => entry.catalog.resolve(target, id, values, positional),
      );
    });
  }
  recordUse(thread: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      const { entry } = await this.get(thread);
      entry.catalog.recordUse(id);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.serial;
    for (const entry of this.entries.values()) {
      entry.stopMetadata();
      await entry.refreshing;
      await entry.files.close();
      await entry.pluginFiles?.files.close();
    }
    this.entries.clear();
  }
}

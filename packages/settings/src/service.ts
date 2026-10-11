import { FileCache, type FileLease } from "./cache.ts";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SettingsKey,
  SettingsValues as SettingsSchemas,
  type SettingsValues,
  type SettingsDiagnostic,
  type SettingsProvenance,
  type SettingsEntry,
} from "@ace/protocol";
import { WorkspaceGuards } from "./workspace.ts";
import { defaults } from "./defaults.ts";
import { SettingsError, validateValue } from "./document.ts";
import { SettingsFile, freeze, type FileChange } from "./file.ts";
import { fileIO, scheduler, type FileIO, type Scheduler } from "./io.ts";

export interface Scope {
  workspace?: string;
  thread?: string;
}
export type Layer =
  | { kind: "global" }
  | { kind: "workspace"; workspace: string }
  | { kind: "thread"; thread: string };
export interface Selector {
  keys: SettingsKey[];
  scope: Scope;
}
export type Notification =
  | { type: "changed"; entries: SettingsEntry[] }
  | { type: "diagnostic"; diagnostic: SettingsDiagnostic };
interface LayerFile extends FileLease {
  layer: SettingsProvenance;
}
interface Subscription {
  keys: SettingsKey[];
  files: LayerFile[];
  last: Map<SettingsKey, SettingsEntry>;
  listener(notification: Notification): void;
}
export interface SettingsOptions {
  dataDir: string;
  io?: FileIO;
  scheduler?: Scheduler;
  debounceMs?: number;
  onListenerError?: (error: unknown) => void;
}
export class SettingsService {
  private cache = new FileCache();
  private workspaces = new WorkspaceGuards();
  private index = new Map<SettingsFile, Map<SettingsKey, Set<Subscription>>>();
  private subscriptions = new Set<Subscription>();
  private options: SettingsOptions;
  private closed = false;
  private changes = new Set<(layer: Layer, keys: readonly SettingsKey[]) => void>();
  private pendingSubscriptions = 0;
  constructor(options: SettingsOptions) {
    this.options = options;
    freeze(defaults);
  }
  private path(layer: Layer): string {
    if (layer.kind === "global") return resolve(this.options.dataDir, "settings.json");
    if (layer.kind === "workspace") return resolve(layer.workspace, ".ace", "settings.json");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(layer.thread))
      throw new SettingsError("validation", "Invalid thread settings ID");
    return resolve(this.options.dataDir, "threads", layer.thread, "settings.json");
  }
  private async file(layer: Layer): Promise<LayerFile> {
    if (this.closed) throw new SettingsError("io", "Settings service is closed");
    const path = this.path(layer);
    const guard =
      layer.kind === "workspace"
        ? await this.workspaces.get(layer.workspace)
        : await this.workspaces.forFile(path);
    const lease = await this.cache.acquire(path, async () => {
      const file = new SettingsFile({
        ...(guard ? { validate: guard } : {}),
        path,
        layer: layer.kind,
        io: this.options.io ?? fileIO,
        timers: this.options.scheduler ?? scheduler,
        delay: this.options.debounceMs ?? 75,
        changed: (change) => this.notify(file, change, layer),
      });
      return file;
    });
    try {
      if (guard) await lease.file.protect(guard);
      return { ...lease, layer: layer.kind };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  private async scope(scope: Scope): Promise<LayerFile[]> {
    const files: LayerFile[] = [];
    try {
      // Acquire the workspace first so a cold physical alias is guarded before global reload.
      if (scope.workspace !== undefined)
        files.push(await this.file({ kind: "workspace", workspace: scope.workspace }));
      files.unshift(await this.file({ kind: "global" }));
      if (scope.thread !== undefined)
        files.push(await this.file({ kind: "thread", thread: scope.thread }));
      return files;
    } catch (error) {
      for (const file of files) file.release();
      throw error;
    }
  }
  private resolve<K extends SettingsKey>(
    key: K,
    files: LayerFile[],
  ): {
    key: K;
    value: SettingsValues[K];
    provenance: SettingsProvenance;
    localValue?: SettingsEntry["localValue"];
  } {
    if (key === "permissions.providerModes") {
      let value: SettingsValues["permissions.providerModes"] = {};
      let provenance: SettingsProvenance = "defaults";
      for (const { file, layer } of files) {
        const own = file.document.settings["permissions.providerModes"];
        if (own !== undefined) {
          Object.assign(value, own);
          provenance = layer;
        }
      }
      const localValue = files.at(-1)?.file.document.settings["permissions.providerModes"] ?? {};
      return freeze({
        key,
        value: SettingsSchemas.shape[key].parse(value) as SettingsValues[K],
        provenance,
        localValue,
      });
    }
    for (let index = files.length - 1; index >= 0; index--) {
      const file = files[index];
      if (file && Object.hasOwn(file.file.document.settings, key)) {
        // Every known document value has been validated by SettingsDocument.
        return freeze({
          key,
          value: file.file.document.settings[key] as SettingsValues[K],
          provenance: file.layer,
        });
      }
    }
    return freeze({ key, value: defaults[key], provenance: "defaults" });
  }
  async get<K extends SettingsKey>(key: K, scope: Scope = {}) {
    SettingsKey.parse(key);
    const files = await this.scope(scope);
    try {
      return this.resolve(key, files);
    } finally {
      for (const file of files) file.release();
    }
  }
  async read(
    selector: Selector,
  ): Promise<{ entries: SettingsEntry[]; diagnostics: SettingsDiagnostic[] }> {
    const keys = this.keys(selector.keys);
    const files = await this.scope(selector.scope);
    try {
      return {
        entries: keys.map((key) => this.resolve(key, files)),
        diagnostics: files.flatMap(({ file, layer }) =>
          file.diagnostic ? [{ ...file.diagnostic, layer }] : [],
        ),
      };
    } finally {
      for (const file of files) file.release();
    }
  }

  async set<K extends SettingsKey>(key: K, value: SettingsValues[K], layer: Layer): Promise<void> {
    SettingsKey.parse(key);
    if (key === "browser.allowedOrigins" && layer.kind !== "global")
      throw new SettingsError("validation", "Browser allowlist is a global user setting");
    if (key === "providers.configuration" && layer.kind !== "global")
      throw new SettingsError("validation", "Provider configuration is a global user setting");
    if (key === "projects.roots" && layer.kind !== "global")
      throw new SettingsError("validation", "Project folders are a global user setting");
    const parsed = validateValue(key, value);
    const lease = await this.file(layer);
    try {
      await lease.file.set(key, parsed);
    } finally {
      lease.release();
    }
  }
  /** One global file commit: subscribers see the complete reset together. */
  async reset(keys: readonly SettingsKey[]): Promise<void> {
    const parsed = keys.map((key) => SettingsKey.parse(key));
    const lease = await this.file({ kind: "global" });
    try {
      await lease.file.reset(parsed);
    } finally {
      lease.release();
    }
  }
  private keys(keys: SettingsKey[]): SettingsKey[] {
    if (keys.length < 1 || keys.length > 32)
      throw new SettingsError("limit", "Select between 1 and 32 settings keys");
    return [...new Set(keys.map((key) => SettingsKey.parse(key)))];
  }
  async subscribe(
    selector: Selector,
    listener: (notification: Notification) => void,
  ): Promise<() => void> {
    if (this.subscriptions.size + this.pendingSubscriptions >= 1024)
      throw new SettingsError("limit", "Settings subscription limit reached");
    this.pendingSubscriptions++;
    try {
      const keys = this.keys(selector.keys);
      const files = await this.scope(selector.scope);
      if (this.closed) {
        for (const file of files) file.release();
        throw new SettingsError("io", "Settings service is closed");
      }
      const sub: Subscription = {
        keys,
        files,
        listener,
        last: new Map(keys.map((key) => [key, this.resolve(key, files)])),
      };
      this.subscriptions.add(sub);
      for (const { file } of files) {
        let index = this.index.get(file);
        if (!index) {
          index = new Map();
          this.index.set(file, index);
        }
        for (const key of keys) {
          let bucket = index.get(key);
          if (!bucket) {
            bucket = new Set();
            index.set(key, bucket);
          }
          bucket.add(sub);
        }
      }
      return () => {
        if (!this.subscriptions.delete(sub)) return;
        for (const file of files) file.release();
        for (const { file } of files)
          for (const key of keys) {
            const index = this.index.get(file);
            const bucket = index?.get(key);
            bucket?.delete(sub);
            if (!bucket?.size) index?.delete(key);
            if (!index?.size) this.index.delete(file);
          }
      };
    } finally {
      this.pendingSubscriptions--;
    }
  }
  private deliver(sub: Subscription, notification: Notification): void {
    try {
      sub.listener(notification);
    } catch (error) {
      try {
        this.options.onListenerError?.(error);
      } catch {
        /* Listener failures cannot undo committed writes. */
      }
    }
  }
  /** Observe effective-file writes at the owning daemon boundary, including scoped layers. */
  onChange(listener: (layer: Layer, keys: readonly SettingsKey[]) => void): () => void {
    if (this.closed || this.changes.size >= 64)
      throw new SettingsError("limit", "Settings change listener limit reached");
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }
  private notify(file: SettingsFile, change: FileChange, layer: Layer): void {
    for (const listener of this.changes) {
      try {
        listener(layer, change.keys);
      } catch (error) {
        try {
          this.options.onListenerError?.(error);
        } catch {
          /* Reporting cannot undo committed settings. */
        }
      }
    }
    const index = this.index.get(file);
    if (!index) return;
    const affected = new Map<Subscription, Set<SettingsKey>>();
    for (const key of change.keys)
      for (const sub of index.get(key) ?? []) {
        let keys = affected.get(sub);
        if (!keys) {
          keys = new Set();
          affected.set(sub, keys);
        }
        keys.add(key);
      }
    for (const [sub, keys] of affected) {
      const entries = [...keys]
        .map((key) => this.resolve(key, sub.files))
        .filter((entry) => !isDeepStrictEqual(entry, sub.last.get(entry.key)));
      for (const entry of entries) sub.last.set(entry.key, entry);
      if (entries.length) this.deliver(sub, { type: "changed", entries });
    }
    if (change.diagnostic) {
      const subscribers = new Set<Subscription>();
      for (const bucket of index.values()) for (const sub of bucket) subscribers.add(sub);
      for (const sub of subscribers)
        this.deliver(sub, {
          type: "diagnostic",
          diagnostic: {
            ...change.diagnostic,
            layer:
              sub.files.findLast((entry) => entry.file === file)?.layer ?? change.diagnostic.layer,
          },
        });
    }
  }
  /** Deterministic reconciliation hook for callers that already observed a file change. */
  async refresh(layer: Layer): Promise<void> {
    const lease = await this.file(layer);
    try {
      await lease.file.reload();
    } finally {
      lease.release();
    }
  }
  /** Wait for already queued file work without causing another read. */
  async settled(layer: Layer): Promise<void> {
    const lease = await this.file(layer);
    try {
      await lease.file.settled();
    } finally {
      lease.release();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.cache.close();
    await this.workspaces.close();
    this.changes.clear();
    this.subscriptions.clear();
    this.index.clear();
  }
}

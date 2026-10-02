import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SettingsKey,
  type SettingsValues,
  type SettingsDiagnostic,
  type SettingsProvenance,
  type SettingsEntry,
} from "@ace/protocol";
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
interface Subscription {
  keys: SettingsKey[];
  files: SettingsFile[];
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
  private files = new Map<string, { file: SettingsFile; ready: Promise<void> }>();
  private index = new Map<SettingsFile, Map<SettingsKey, Set<Subscription>>>();
  private subscriptions = new Set<Subscription>();
  private options: SettingsOptions;
  private closed = false;
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
  private async file(layer: Layer): Promise<SettingsFile> {
    if (this.closed) throw new SettingsError("io", "Settings service is closed");
    const path = this.path(layer);
    let entry = this.files.get(path);
    if (!entry) {
      if (this.files.size >= 64)
        throw new SettingsError(
          "limit",
          "Settings file limit reached; restart to release inactive scopes",
        );
      const file = new SettingsFile({
        path,
        layer: layer.kind,
        io: this.options.io ?? fileIO,
        timers: this.options.scheduler ?? scheduler,
        delay: this.options.debounceMs ?? 75,
        changed: (change) => this.notify(file, change),
      });
      entry = { file, ready: file.reload() };
      this.files.set(path, entry);
    }
    await entry.ready;
    return entry.file;
  }
  private async scope(scope: Scope): Promise<SettingsFile[]> {
    const files = [await this.file({ kind: "global" })];
    if (scope.workspace !== undefined)
      files.push(await this.file({ kind: "workspace", workspace: scope.workspace }));
    if (scope.thread !== undefined)
      files.push(await this.file({ kind: "thread", thread: scope.thread }));
    return files;
  }
  private resolve<K extends SettingsKey>(
    key: K,
    files: SettingsFile[],
  ): { key: K; value: SettingsValues[K]; provenance: SettingsProvenance } {
    for (let index = files.length - 1; index >= 0; index--) {
      const file = files[index];
      if (file && Object.hasOwn(file.document.settings, key)) {
        // Every known document value has been validated by SettingsDocument.
        return freeze({
          key,
          value: file.document.settings[key] as SettingsValues[K],
          provenance: file.layer,
        });
      }
    }
    return freeze({ key, value: defaults[key], provenance: "defaults" });
  }
  async get<K extends SettingsKey>(key: K, scope: Scope = {}) {
    SettingsKey.parse(key);
    return this.resolve(key, await this.scope(scope));
  }
  async read(
    selector: Selector,
  ): Promise<{ entries: SettingsEntry[]; diagnostics: SettingsDiagnostic[] }> {
    const keys = this.keys(selector.keys);
    const files = await this.scope(selector.scope);
    return {
      entries: keys.map((key) => this.resolve(key, files)),
      diagnostics: files.flatMap((file) => (file.diagnostic ? [file.diagnostic] : [])),
    };
  }
  async set<K extends SettingsKey>(key: K, value: SettingsValues[K], layer: Layer): Promise<void> {
    SettingsKey.parse(key);
    const parsed = validateValue(key, value);
    await (await this.file(layer)).set(key, parsed);
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
      if (this.closed) throw new SettingsError("io", "Settings service is closed");
      const sub: Subscription = {
        keys,
        files,
        listener,
        last: new Map(keys.map((key) => [key, this.resolve(key, files)])),
      };
      this.subscriptions.add(sub);
      for (const file of files) {
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
        this.subscriptions.delete(sub);
        for (const file of files)
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
  private notify(file: SettingsFile, change: FileChange): void {
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
        this.deliver(sub, { type: "diagnostic", diagnostic: change.diagnostic });
    }
  }
  /** Deterministic reconciliation hook for callers that already observed a file change. */
  async refresh(layer: Layer): Promise<void> {
    await (await this.file(layer)).reload();
  }
  /** Wait for already queued file work without causing another read. */
  async settled(layer: Layer): Promise<void> {
    await (await this.file(layer)).settled();
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.files.values()].map(({ file }) => file.close()));
    this.subscriptions.clear();
    this.index.clear();
    this.files.clear();
  }
}

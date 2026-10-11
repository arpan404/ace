import { isDeepStrictEqual } from "node:util";
import { SettingsKey, type SettingsDiagnostic, type SettingsProvenance } from "@ace/protocol";
import {
  decode,
  assign,
  resetPreferences,
  emptyText,
  SettingsError,
  type DecodedDocument,
} from "./document.ts";
import type { FileIO, Scheduler } from "./io.ts";

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export type FileChange = { keys: SettingsKey[]; diagnostic?: SettingsDiagnostic };
export class SettingsFile {
  private prepared = decode(emptyText);
  document: DecodedDocument["document"] = freeze(this.prepared.document);
  private documentDiagnostic: SettingsDiagnostic | undefined;
  private watcherDiagnostic: SettingsDiagnostic | undefined;
  get diagnostic(): SettingsDiagnostic | undefined {
    return this.documentDiagnostic ?? this.watcherDiagnostic;
  }
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private stopWatch: (() => void) | undefined;
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  readonly path: string;
  readonly layer: SettingsProvenance;
  private io: FileIO;
  private timers: Scheduler;
  private delay: number;
  private validate: (() => Promise<void>) | undefined;
  private changed: (change: FileChange) => void;
  constructor(options: {
    path: string;
    layer: SettingsProvenance;
    io: FileIO;
    timers: Scheduler;
    delay: number;
    validate?: () => Promise<void>;
    changed(change: FileChange): void;
  }) {
    this.path = options.path;
    this.layer = options.layer;
    this.io = options.io;
    this.timers = options.timers;
    this.delay = options.delay;
    this.changed = options.changed;
    this.validate = options.validate;
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SettingsError("io", "Settings service is closed"));
    if (this.queued >= 64)
      return Promise.reject(new SettingsError("limit", "Settings file queue is full"));
    this.queued++;
    const result = this.tail.then(run);
    this.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.queued--;
      });
    return result;
  }
  private report(error: unknown): void {
    const known =
      error instanceof SettingsError
        ? error
        : new SettingsError("io", "Cannot read or write settings file");
    const diagnostic = freeze({
      layer: this.layer,
      code: known.code,
      message: known.message,
      ...(known.offset === undefined ? {} : { offset: known.offset }),
    });
    if (isDeepStrictEqual(this.documentDiagnostic, diagnostic)) return;
    this.documentDiagnostic = diagnostic;
    this.changed({ keys: [], diagnostic });
  }
  private publish(prepared: DecodedDocument): void {
    const document = prepared.document;
    this.prepared = { ...prepared, migrated: false };
    const keys = SettingsKey.options.filter(
      (key) =>
        !isDeepStrictEqual(this.document.settings[key], document.settings[key]) ||
        Object.hasOwn(this.document.settings, key) !== Object.hasOwn(document.settings, key),
    );
    this.document = freeze(document);
    this.documentDiagnostic = undefined;
    if (keys.length) this.changed({ keys });
  }
  private watchFailed(): void {
    const diagnostic = freeze({
      layer: this.layer,
      code: "io" as const,
      message: "Settings watcher failed",
    });
    if (!isDeepStrictEqual(this.watcherDiagnostic, diagnostic)) {
      this.watcherDiagnostic = diagnostic;
      this.changed({ keys: [], diagnostic });
    }
    this.schedule();
  }
  private async rewatch(): Promise<void> {
    if (this.closed) return;
    try {
      const stop = await this.io.watch(
        this.path,
        () => this.schedule(),
        () => this.watchFailed(),
      );
      this.stopWatch?.();
      if (this.closed) stop();
      else {
        this.stopWatch = stop;
        this.watcherDiagnostic = undefined;
      }
    } catch {
      this.watchFailed();
    }
  }
  private schedule(): void {
    if (this.closed) return;
    this.cancelTimer?.();
    this.cancelTimer = this.timers.schedule(() => {
      this.cancelTimer = undefined;
      void this.reload().catch((error: unknown) => this.report(error));
    }, this.delay);
  }
  /** Attach the logical workspace's permanent guard even to a pre-existing global alias. */
  protect(validate: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      this.validate ??= validate;
      try {
        await this.validate();
      } catch (error) {
        this.report(error);
      }
    });
  }
  reload(): Promise<void> {
    return this.enqueue(async () => {
      await this.rewatch();
      try {
        await this.validate?.();
        const source = (await this.io.read(this.path)) ?? emptyText;
        const result = source === this.prepared.text ? this.prepared : decode(source);
        if (result.migrated) await this.io.write(this.path, result.text, this.validate);
        this.publish(result);
      } catch (error) {
        this.report(error);
      }
    });
  }
  set(key: SettingsKey, value: unknown): Promise<void> {
    return this.update((source) => assign(source, key, value));
  }
  reset(keys: readonly SettingsKey[]): Promise<void> {
    return this.update((source) => resetPreferences(source, keys));
  }
  private update(change: (source: DecodedDocument) => DecodedDocument): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.validate?.();
        const raw = (await this.io.read(this.path)) ?? emptyText;
        const source = raw === this.prepared.text ? this.prepared : decode(raw);
        const result = change(source);
        const text = result.text;
        if (source.migrated || text !== source.text)
          await this.io.write(this.path, text, this.validate);
        this.publish(result);
        await this.rewatch();
      } catch (error) {
        this.report(error);
        throw error;
      }
    });
  }
  async settled(): Promise<void> {
    await this.tail;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer?.();
    this.stopWatch?.();
    await this.tail;
    this.stopWatch?.();
  }
}

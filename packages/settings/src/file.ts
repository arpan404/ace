import { isDeepStrictEqual } from "node:util";
import {
  SettingsKey,
  type SettingsDocument,
  type SettingsDiagnostic,
  type SettingsProvenance,
} from "@ace/protocol";
import { decode, edit, emptyText, SettingsError } from "./document.ts";
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
  document: SettingsDocument = freeze(decode(emptyText).document);
  diagnostic: SettingsDiagnostic | undefined;
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
  private changed: (change: FileChange) => void;
  constructor(options: {
    path: string;
    layer: SettingsProvenance;
    io: FileIO;
    timers: Scheduler;
    delay: number;
    changed(change: FileChange): void;
  }) {
    this.path = options.path;
    this.layer = options.layer;
    this.io = options.io;
    this.timers = options.timers;
    this.delay = options.delay;
    this.changed = options.changed;
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
    this.diagnostic = freeze({
      layer: this.layer,
      code: known.code,
      message: known.message,
      ...(known.offset === undefined ? {} : { offset: known.offset }),
    });
    this.changed({ keys: [], diagnostic: this.diagnostic });
  }
  private publish(document: SettingsDocument): void {
    const keys = SettingsKey.options.filter(
      (key) =>
        !isDeepStrictEqual(this.document.settings[key], document.settings[key]) ||
        Object.hasOwn(this.document.settings, key) !== Object.hasOwn(document.settings, key),
    );
    this.document = freeze(document);
    this.diagnostic = undefined;
    if (keys.length) this.changed({ keys });
  }
  private async rewatch(): Promise<void> {
    if (this.closed) return;
    try {
      const stop = await this.io.watch(
        this.path,
        () => this.schedule(),
        () => this.report(new SettingsError("io", "Settings watcher failed")),
      );
      this.stopWatch?.();
      if (this.closed) stop();
      else this.stopWatch = stop;
    } catch (error) {
      this.report(error);
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
  reload(): Promise<void> {
    return this.enqueue(async () => {
      await this.rewatch();
      try {
        const source = (await this.io.read(this.path)) ?? emptyText;
        const result = decode(source);
        if (result.migrated) await this.io.write(this.path, result.text);
        this.publish(result.document);
      } catch (error) {
        this.report(error);
      }
    });
  }
  set(key: SettingsKey, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      try {
        const source = decode((await this.io.read(this.path)) ?? emptyText);
        const text = edit(source.text, ["settings", key], value);
        const result = decode(text);
        if (source.migrated || text !== source.text) await this.io.write(this.path, text);
        this.publish(result.document);
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

import type { DatabaseSync } from "node:sqlite";
import type { ThreadId } from "@ace/protocol";
import { Append, restoreAppend } from "./append.ts";
import { z } from "zod";

/** Disk-backed dictionaries return plain entities, so core can clone emitted events. */
export class Records<T> {
  readonly values: Record<string, T>;
  private cache = new Map<string, { value: T; json: string; bytes: number }>();
  private tracking = false;
  private replaced = new Set<string>();
  private appended = new Set<string>();
  private touched = new Map<string, T | undefined>();
  private db: DatabaseSync;
  private thread: ThreadId;
  private group: string;
  private decoder: z.ZodType<T>;
  private decorate: (key: string, value: T) => T;
  private encode: (key: string, value: T) => string;
  constructor(
    db: DatabaseSync,
    thread: ThreadId,
    group: string,
    schema: z.ZodType<T>,
    initial: Record<string, T>,
    decorate: (key: string, value: T) => T = (_key, value) => value,
    encode: (key: string, value: T) => string = (_key, value) => JSON.stringify(value),
  ) {
    this.db = db;
    this.thread = thread;
    this.group = group;
    this.decoder = z.custom<T>((value) => schema.safeParse(value).success);
    this.decorate = decorate;
    this.encode = encode;
    const target: Record<string, T> = {};
    Object.setPrototypeOf(target, null);
    this.values = new Proxy(target, {
      get: (_target, key) => (typeof key === "string" ? this.read(key) : undefined),
      ownKeys: () => this.keys(),
      getOwnPropertyDescriptor: (_target, key) => {
        if (typeof key !== "string") return undefined;
        const value = this.read(key);
        return value === undefined
          ? undefined
          : { value, enumerable: true, writable: true, configurable: true };
      },
      defineProperty: (_target, key, descriptor) => {
        if (typeof key !== "string") throw new Error("Snapshot keys must be strings");
        // Core-created entities also cross the persistence boundary.
        this.write(key, this.decoder.parse(descriptor.value));
        return true;
      },
      set: (_target, key, value: unknown) => {
        if (typeof key !== "string") throw new Error("Snapshot keys must be strings");
        this.write(key, this.decoder.parse(value));
        return true;
      },
      deleteProperty: (_target, key) => {
        if (typeof key === "string") {
          this.touched.set(key, undefined);
          this.cache.delete(key);
        }
        return true;
      },
    });
    for (const [key, value] of Object.entries(initial)) this.write(key, value);
  }
  private write(key: string, value: T): void {
    const decorated = this.decorate(key, value);
    const previous = this.cache.get(key)?.json ?? "";
    this.cache.set(key, { value: decorated, json: previous, bytes: Buffer.byteLength(previous) });
    this.replaced.add(key);
    this.touched.set(key, decorated);
  }
  private read(key: string): T | undefined {
    if (this.touched.has(key)) return this.touched.get(key);
    let entry = this.cache.get(key);
    if (!entry) {
      const row = this.db
        .prepare("SELECT value FROM engine_state_records WHERE thread_id=? AND section=? AND key=?")
        .get(this.thread, this.group, key);
      if (!row) return undefined;
      const json = String(row.value);
      let value: unknown = JSON.parse(json);
      let bytes = Buffer.byteLength(json);
      for (const appendRow of this.db
        .prepare(
          "SELECT patch FROM engine_state_appends WHERE thread_id=? AND section=? AND key=? ORDER BY id",
        )
        .iterate(this.thread, this.group, key)) {
        const patch = Append.parse(JSON.parse(String(appendRow.patch)));
        value = restoreAppend(value, patch);
        bytes += Buffer.byteLength(patch.text);
      }
      entry = { json, bytes, value: this.decorate(key, this.decoder.parse(value)) };
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    // An accessed plain entity can be mutated in place by core.
    if (this.tracking) this.touched.set(key, entry.value);
    else this.trim();
    return entry.value;
  }
  private keys(): string[] {
    const keys = new Set(
      this.db
        .prepare(
          "SELECT key FROM engine_state_records WHERE thread_id=? AND section=? ORDER BY rowid",
        )
        .all(this.thread, this.group)
        .map((row) => String(row.key)),
    );
    for (const [key, value] of this.touched) {
      if (value === undefined) keys.delete(key);
      else keys.add(key);
    }
    return Object.keys(Object.fromEntries([...keys].map((key) => [key, true])));
  }
  append(key: string, patch: Append): void {
    const entry = this.cache.get(key);
    if (!entry || !entry.json || this.replaced.has(key)) return;
    this.db
      .prepare("INSERT INTO engine_state_appends (thread_id,section,key,patch) VALUES (?, ?, ?, ?)")
      .run(this.thread, this.group, key, JSON.stringify(patch));
    entry.bytes += Buffer.byteLength(patch.text);
    this.appended.add(key);
  }
  begin(): void {
    this.tracking = true;
  }
  retainChanges(changed: (value: T) => boolean): void {
    for (const [key, value] of this.touched)
      if (
        value !== undefined &&
        !this.replaced.has(key) &&
        !this.appended.has(key) &&
        !changed(value)
      )
        this.touched.delete(key);
  }
  flush(): void {
    for (const [key, value] of this.touched) {
      if (value === undefined) {
        this.db
          .prepare("DELETE FROM engine_state_appends WHERE thread_id=? AND section=? AND key=?")
          .run(this.thread, this.group, key);
        this.db
          .prepare("DELETE FROM engine_state_records WHERE thread_id=? AND section=? AND key=?")
          .run(this.thread, this.group, key);
        continue;
      }
      if (this.appended.has(key) && !this.replaced.has(key)) continue;
      const json = this.encode(key, value);
      if (json !== this.cache.get(key)?.json || this.replaced.has(key)) {
        this.db
          .prepare("DELETE FROM engine_state_appends WHERE thread_id=? AND section=? AND key=?")
          .run(this.thread, this.group, key);
        this.db
          .prepare(
            `INSERT INTO engine_state_records VALUES (?, ?, ?, ?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value`,
          )
          .run(this.thread, this.group, key, json);
      }
      this.cache.set(key, { value, json, bytes: Buffer.byteLength(json) });
    }
    this.touched.clear();
    this.replaced.clear();
    this.appended.clear();
    this.tracking = false;
    this.trim();
  }
  private trim(): void {
    // Historical entities stay on disk. A single large entity is not retained.
    let bytes = 0;
    const entries = [...this.cache.entries()].toReversed();
    for (const [index, [key, entry]] of entries.entries()) {
      bytes += entry.bytes;
      if (bytes > 1_048_576 || index >= 128) this.cache.delete(key);
    }
  }
}

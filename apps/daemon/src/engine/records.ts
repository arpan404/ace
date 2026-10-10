import { RecordCache, type RecordTransaction } from "./record-cache.ts";
import type { DatabaseSync } from "node:sqlite";
import type { ThreadId } from "@ace/protocol";
import { Append, restoreAppend } from "./append.ts";
import { z } from "zod";
function validRecord<T>(schema: z.ZodType<T>, value: unknown): value is T {
  return schema.safeParse(value).success;
}
function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  if (!validRecord(schema, value)) throw new Error("Invalid snapshot record");
  // Validate without stripping future fields. Reuse the schema's compiled validator.
  return value;
}

/** Disk-backed dictionaries return plain entities, so core can clone emitted events. */
export class Records<T> {
  readonly values: Record<string, T>;
  private readonly cache: RecordCache;
  private readonly transaction: RecordTransaction | undefined;
  private tracking = false;
  private appendValue: { key: string; value: T } | undefined;
  private replaced = new Set<string>();
  private appended = new Set<string>();
  private touched = new Map<string, T | undefined>();
  // Transaction baselines must survive LRU eviction. Reading is not a write.
  private originals = new Map<string, string>();
  private enumerated: Set<string> | undefined;
  private db: Pick<DatabaseSync, "prepare">;
  private thread: ThreadId;
  private group: string;
  private decoder: z.ZodType<T>;
  private decorate: (key: string, value: T) => T;
  private encode: (key: string, value: T) => string;
  constructor(
    db: Pick<DatabaseSync, "prepare">,
    thread: ThreadId,
    group: string,
    schema: z.ZodType<T>,
    initial: Record<string, T>,
    decorate: (key: string, value: T) => T = (_key, value) => value,
    encode: (key: string, value: T) => string = (_key, value) => JSON.stringify(value),
    cache = new RecordCache(),
    transaction?: RecordTransaction,
  ) {
    this.cache = cache;
    this.transaction = transaction;
    this.db = db;
    this.thread = thread;
    this.group = group;
    this.decoder = schema;
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
        this.write(key, parseRecord(this.decoder, descriptor.value));
        return true;
      },
      set: (_target, key, value: unknown) => {
        if (typeof key !== "string") throw new Error("Snapshot keys must be strings");
        this.write(key, parseRecord(this.decoder, value));
        return true;
      },
      deleteProperty: (_target, key) => {
        if (typeof key === "string") {
          this.access(true);
          this.touched.set(key, undefined);
          this.cache.delete(this.group, key);
          this.enumerated?.delete(key);
        }
        return true;
      },
    });
    for (const [key, value] of Object.entries(initial)) this.write(key, value);
  }
  private access(write = false): void {
    if (this.transaction?.tracking) {
      this.tracking = true;
      this.transaction.touch(this);
    } else if (write) this.transaction?.touch(this);
  }
  private write(key: string, value: T): void {
    this.access(true);
    const decorated = this.decorate(key, value);
    const previous = this.cache.get<T>(this.group, key)?.json ?? "";
    this.cache.set(this.group, key, {
      value: decorated,
      json: previous,
      bytes: Buffer.byteLength(previous),
    });
    this.replaced.add(key);
    this.touched.set(key, decorated);
    this.enumerated?.add(key);
  }
  private read(key: string): T | undefined {
    this.access();
    if (this.appendValue?.key === key) {
      if (this.tracking) this.touched.set(key, this.appendValue.value);
      return this.appendValue.value;
    }
    if (this.touched.has(key)) return this.touched.get(key);
    let entry = this.cache.get<T>(this.group, key);
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
      entry = { json, bytes, value: this.decorate(key, parseRecord(this.decoder, value)) };
    }
    this.cache.delete(this.group, key);
    this.cache.set(this.group, key, entry);
    // An accessed plain entity can be mutated in place by core.
    if (this.tracking) {
      this.touched.set(key, entry.value);
      this.originals.set(key, entry.json);
    }
    return entry.value;
  }
  private keys(): string[] {
    this.access();
    const keys =
      this.enumerated ??
      new Set(
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
    if (this.tracking) this.enumerated = keys;
    return Object.keys(Object.fromEntries([...keys].map((key) => [key, true])));
  }
  hasReplacement(key: string): boolean {
    return this.replaced.has(key);
  }
  useAppendValue(key: string, value: T): () => void {
    this.appendValue = { key, value };
    return () => {
      this.appendValue = undefined;
      if (this.appended.has(key)) {
        // The full cached value predates this chunk. Materialize it only for a full read.
        this.cache.delete(this.group, key);
        this.touched.delete(key);
      } else if (!this.replaced.has(key)) this.touched.delete(key);
    };
  }
  append(key: string, patch: Append): void {
    this.access(true);
    const entry = this.cache.get<T>(this.group, key);
    if (this.replaced.has(key) || (!entry?.json && this.appendValue?.key !== key)) return;
    this.db
      .prepare("INSERT INTO engine_state_appends (thread_id,section,key,patch) VALUES (?, ?, ?, ?)")
      .run(this.thread, this.group, key, JSON.stringify(patch));
    if (entry) entry.bytes += Buffer.byteLength(patch.text);
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
      if (
        json !== (this.originals.get(key) ?? this.cache.get<T>(this.group, key)?.json) ||
        this.replaced.has(key)
      ) {
        this.db
          .prepare("DELETE FROM engine_state_appends WHERE thread_id=? AND section=? AND key=?")
          .run(this.thread, this.group, key);
        this.db
          .prepare(
            `INSERT INTO engine_state_records VALUES (?, ?, ?, ?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value`,
          )
          .run(this.thread, this.group, key, json);
      }
      this.cache.set(this.group, key, { value, json, bytes: Buffer.byteLength(json) });
    }
    this.touched.clear();
    this.originals.clear();
    this.enumerated = undefined;
    this.replaced.clear();
    this.appended.clear();
    this.tracking = false;
  }
}

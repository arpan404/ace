// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 3 native reads (ADR 0222): decode sidebar and thread-list rows in Rust.
 *
 * The TypeScript loaders keep issuing their SQL on the store's connection,
 * inside the store's read savepoint (`SidebarReads`' snapshot), and hand the
 * rows they read to one Rust call (`sidebarDecodeThreadRows`), which decodes
 * every trusted thread row exactly as `decodeThreadRow`'s trusted path does
 * and returns the threads as one JSON string. Decoding whole thread rows in
 * JavaScript was the measured cost of these reads (71-74% outside SQLite on a
 * sidebar page, 68-69% listing all threads), so it moves to Rust; the SQL, the
 * page and summary caches, the snapshot, the freezing and the row revisions
 * stay in TypeScript around it.
 *
 * Two deliberate deviations from the porting guide's letter, both forced by
 * what reaches the call site:
 *
 * - The bindings take rows, not `&NativeDatabase`. `sidebarPageStorage`
 *   receives only statement and decode closures (its direct test callers pass
 *   raw statements with no store handle), so no connection handle reaches any
 *   of these loaders without new plumbing through files other phases own. The
 *   reads still run on the store's own connection: the SQL is issued through
 *   the store's statement closures, inside its read savepoint, and Rust only
 *   decodes and shapes. `listThreads` and `readThreads` keep the same shape
 *   for uniformity and to keep their SQL single-sourced in TypeScript.
 * - The sidebar switch sits in `SidebarReads.loadSidebarPage`, reusing
 *   `sidebarPageStorage` verbatim for membership, order, counts and the
 *   snapshot, rather than at the top of `sidebarPageStorage` itself. Each row
 *   carries its row revision in `SidebarReads`' private map, which only
 *   `loadSidebarPage` can record into; switching below it would bypass the
 *   page cache, the summary cache and the live window.
 *
 * Trust: a row the trust stamp confirms at its current revision decodes in
 * Rust as stored. Any other row comes back marked and is decoded here with the
 * existing decoders (`ThreadCache.decode` for pages, `decodeThreadRow` for
 * lists), so validation, the cursor continuation and the tree-root enrichment
 * behave exactly as they do without the switch. A row whose JSON cannot be
 * read therefore fails, if at all, where the TypeScript decode fails.
 */

import { existsSync } from "node:fs";
import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  Thread,
  ThreadId,
  ThreadListCursor,
  ThreadListEntry,
  ThreadListWindow,
} from "@ace/protocol";
import { decodeThreadRow, threadRowColumns, threadRowSource } from "../thread-row.ts";
import type { FrozenThread } from "../thread-cache.ts";
import { sidebarCursor, sidebarPageStorage } from "../sidebar-page-storage.ts";

/** A row the shell must decode itself with the existing TypeScript decoders. */
const untrustedKey = "$untrusted";

/** The store addon, loaded the way `@ace/provider-kit/sqlite` loads it. */
interface SidebarAddon {
  sidebarDecodeThreadRows(rowsJson: string): string;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_STORE_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: SidebarAddon | undefined;
function addon(): SidebarAddon {
  if (loaded) return loaded;
  const path = addonPath();
  // Never fall back: a run with the switch on proves the native path.
  if (!existsSync(path))
    throw new Error(
      `ACE_STORE=native needs the store addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting `sidebarDecodeThreadRows`.
  loaded = module.exports as unknown as SidebarAddon;
  return loaded;
}

/**
 * Decode rows in Rust, in order: trusted rows decode as stored, any other row
 * decodes to `{ $untrusted: true }` for the shell's TypeScript decode.
 */
function decodeRows(rows: Record<string, SQLOutputValue>[]): unknown[] {
  const parsed: unknown = JSON.parse(addon().sidebarDecodeThreadRows(JSON.stringify(rows)));
  if (!Array.isArray(parsed) || parsed.length !== rows.length)
    throw new Error(
      `sidebar decode returned ${Array.isArray(parsed) ? parsed.length : "no array"} entries for ${rows.length} rows`,
    );
  return parsed;
}

/** A stored row passing through `sidebarPageStorage`, not a retained entry. */
function isRow(value: ThreadListEntry): value is ThreadListEntry & Record<string, SQLOutputValue> {
  return typeof value === "object" && value !== null && "workspace_id" in value;
}

function isUntrusted(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, untrustedKey) === true;
}

/** Frozen subtrees are already deeply frozen here: every cached value is frozen whole. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Whether the thread still needs the store's lazy tree-root resolution
 * (`TreeRootResolver.resolve`): no root recorded, not a host thread, and a
 * delegation ancestry to walk. Anything else resolves to itself.
 */
function needsEnrichment(thread: Thread): boolean {
  return (
    thread.treeRootId === undefined &&
    thread.host === undefined &&
    (thread.delegatedFrom !== undefined ||
      thread.delegatedBy !== undefined ||
      thread.startedBy !== undefined)
  );
}

/** The store the native page reads through: its statements, decode and reads. */
export interface NativeSidebarSource {
  statement(sql: string): StatementSync;
  decode(row: Record<string, SQLOutputValue>, revision: SQLOutputValue | undefined): unknown;
  read(id: string): unknown;
}

type Summary = Pick<ThreadListWindow, "total" | "counts">;

export interface NativeSidebarReuse {
  entries: ReadonlyMap<string, ThreadListEntry>;
  changed: ReadonlySet<string>;
  current(entry: ThreadListEntry, revision: number): boolean;
}

/**
 * The sidebar page with its rows decoded in Rust: membership, order, counts
 * and the snapshot come from `sidebarPageStorage` unchanged, then every row
 * it read decodes in one Rust call. Retained entries pass through as they are;
 * untrusted rows decode through the store, which records their revision,
 * enriches and freezes them like the TypeScript path.
 */
export function loadSidebarPageNative(
  source: NativeSidebarSource,
  options: { limit: number; project?: string | undefined; archived?: boolean | undefined },
  before: ThreadListCursor | undefined,
  reuse: NativeSidebarReuse | undefined,
  record: (entry: ThreadListEntry, revision: number) => void,
  summarize: (load: () => Summary) => Summary,
): { threads: ThreadListEntry[]; window: ThreadListWindow } {
  const stored = sidebarPageStorage(
    (sql) => source.statement(sql),
    // Passed through: rows decode in one Rust batch below, in order.
    (row) => row as unknown as Thread,
    options,
    before,
    reuse,
    summarize,
  );
  const rows: Record<string, SQLOutputValue>[] = [];
  for (const item of stored.threads) if (isRow(item)) rows.push(item);
  const decoded = decodeRows(rows);
  let cursor = 0;
  const threads = stored.threads.map((item) => {
    if (!isRow(item)) return item;
    const revision = Number(item.sidebar_revision);
    const result = decoded[cursor++];
    let entry =
      isUntrusted(result) || result === undefined
        ? (source.decode(item, item.sidebar_revision) as ThreadListEntry)
        : deepFreeze(result as ThreadListEntry);
    // The store's lazy enrichment for pre-upgrade delegated threads, read on
    // the same snapshot; anything else resolves to itself.
    if (needsEnrichment(entry as Thread)) {
      const enriched = source.read((entry as Thread).id) as ThreadListEntry | undefined;
      if (enriched === undefined) throw new Error("Sidebar membership changed within a read");
      entry = enriched;
    }
    record(entry, revision);
    return entry;
  });
  const last = threads.at(-1);
  return {
    threads,
    window: {
      ...stored.window,
      before: stored.window.before && last ? sidebarCursor(last, options.archived) : null,
    },
  };
}

/** Every thread, newest first, with its rows decoded in Rust. */
export function listThreadsNative(statement: (sql: string) => StatementSync): Thread[] {
  const rows = statement(
    `SELECT ${threadRowColumns} FROM ${threadRowSource} ORDER BY updated_at DESC, threads.id`,
  ).all() as Record<string, SQLOutputValue>[];
  const decoded = decodeRows(rows);
  return rows.map((row, index) => {
    const result = decoded[index];
    // Bulk lists never enrich (`tree-root.test.ts`): they decode only.
    if (isUntrusted(result) || result === undefined) return decodeThreadRow(row);
    return result as Thread;
  });
}

/**
 * `readThread` for many threads in one statement, with its rows decoded in
 * Rust. Missing threads have no entry. Values are shared and frozen, as the
 * thread cache's are.
 */
export function readThreadsNative(
  statement: (sql: string) => StatementSync,
  ids: readonly ThreadId[],
  read: (id: string) => FrozenThread | undefined,
): Map<ThreadId, FrozenThread> {
  const threads = new Map<ThreadId, FrozenThread>();
  if (!ids.length) return threads;
  const rows = statement(
    `SELECT ${threadRowColumns}, revisions.revision AS row_revision FROM ${threadRowSource} LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE threads.id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify([...new Set(ids)])) as Record<string, SQLOutputValue>[];
  const decoded = decodeRows(rows);
  rows.forEach((row, index) => {
    const result = decoded[index];
    let entry = deepFreeze(
      (isUntrusted(result) || result === undefined ? decodeThreadRow(row) : result) as FrozenThread,
    );
    // The store's lazy enrichment for pre-upgrade delegated threads.
    if (needsEnrichment(entry as Thread)) {
      const enriched = read(String((entry as Thread).id));
      if (enriched === undefined) throw new Error("Sidebar membership changed within a read");
      entry = enriched;
    }
    threads.set(entry.id, entry);
  });
  return threads;
}

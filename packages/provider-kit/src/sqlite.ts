// Node 24.13.0 gives node:sqlite's ExperimentalWarning no code. Keep Node's
// own output formatter for every other warning, and keep consumer listeners.
// Each SQLite worker isolate installs this filter before queued warnings print.
const defaultWarning = process
  .listeners("warning")
  .find((listener) => listener.name === "onWarning");
if (defaultWarning) {
  process.removeListener("warning", defaultWarning);
  process.on("warning", (warning) => {
    if (
      warning.name === "ExperimentalWarning" &&
      warning.message === "SQLite is an experimental feature and might change at any time" &&
      !("code" in warning)
    )
      return;
    defaultWarning.call(process, warning);
  });
}
import { DatabaseSync as NodeDatabaseSync, type DatabaseSyncOptions } from "node:sqlite";
import { createMissingWal } from "./sqlite-read-only.ts";
import { NativeDatabaseSync } from "./native-sqlite.ts";
export { nativeCall, nativeHandle } from "./native-sqlite.ts";

/** node:sqlite's database, opening read-only WAL databases the same way on Node and Bun. */
class NodeDatabase extends NodeDatabaseSync {
  constructor(path: string | Buffer | URL, options?: DatabaseSyncOptions) {
    // Node rejects an explicit undefined options argument.
    if (options === undefined) super(path);
    else super(path, options);
    if (options?.readOnly === true && typeof path === "string") openReadOnly(this, path);
  }
}

/** The same database served by the daemon's Rust core (ADR 0222, `ACE_STORE=native`). */
class NativeDatabase extends NativeDatabaseSync {
  constructor(path: string | Buffer | URL, options?: DatabaseSyncOptions) {
    super(path, options);
    // Trusted: the native class implements the node:sqlite surface the probe uses.
    if (options?.readOnly === true && typeof path === "string")
      openReadOnly(this as unknown as NodeDatabaseSync, path);
  }
}

/**
 * The daemon's SQLite database class. `ACE_STORE=native`, read once here at the process's
 * I/O boundary, serves every connection from the Rust core, so one SQLite library holds every
 * lock on a file in the process (ADR 0222); unset keeps node:sqlite.
 */
const nativeStore = process.env.ACE_STORE === "native";
// One decision per process: worker isolates inherit this environment, so they choose the same.
if (nativeStore) process.env.ACE_STORE = "native";
else delete process.env.ACE_STORE;

/**
 * Refuse a connection served by the other SQLite library than this process's: two copies of
 * SQLite on one file in one process release each other's locks (ADR 0222).
 */
export function assertProcessSqlite(database: object): void {
  if (database instanceof NativeDatabaseSync !== nativeStore)
    throw new Error(
      nativeStore
        ? "This process serves SQLite from the native store (ACE_STORE=native); a node:sqlite connection cannot share its files"
        : "A native store connection was given to a process running node:sqlite; set ACE_STORE=native for the whole process",
    );
}

export const DatabaseSync: typeof NodeDatabaseSync = nativeStore
  ? // Trusted: NativeDatabaseSync implements the part of node:sqlite's API ace uses and throws
    // a named error for the rest.
    (NativeDatabase as unknown as typeof NodeDatabaseSync)
  : NodeDatabase;
export type DatabaseSync = NodeDatabaseSync;

/**
 * Bun opens the file at the first statement, and fails there for a closed WAL database. A probe
 * surfaces that now; with the missing -wal created, the same connection opens. Any other failure
 * is left for the caller's own statements, as before.
 */
function openReadOnly(db: NodeDatabaseSync, path: string): void {
  const probe = () => db.prepare("SELECT 1 FROM sqlite_master LIMIT 0").all();
  try {
    probe();
  } catch (error) {
    if (!createMissingWal(path, error)) return;
    try {
      probe();
    } catch {
      // The caller's statements report it.
    }
  }
}
export { StatementSync } from "node:sqlite";
export { backup } from "./sqlite-backup.ts";
export type { SQLInputValue, SQLOutputValue } from "node:sqlite";

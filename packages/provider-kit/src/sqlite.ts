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

/** node:sqlite's database, opening read-only WAL databases the same way on Node and Bun. */
export class DatabaseSync extends NodeDatabaseSync {
  constructor(path: string | Buffer | URL, options?: DatabaseSyncOptions) {
    // Node rejects an explicit undefined options argument.
    if (options === undefined) super(path);
    else super(path, options);
    if (options?.readOnly === true && typeof path === "string") openReadOnly(this, path);
  }
}

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

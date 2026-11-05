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
import { prepareReadOnlyOpen } from "./sqlite-read-only.ts";

/** node:sqlite's database, opening read-only WAL databases the same way on Node and Bun. */
export class DatabaseSync extends NodeDatabaseSync {
  constructor(path: string | Buffer | URL, options?: DatabaseSyncOptions) {
    if (options?.readOnly === true && typeof path === "string") prepareReadOnlyOpen(path);
    // Node rejects an explicit undefined options argument.
    if (options === undefined) super(path);
    else super(path, options);
  }
}
export { StatementSync } from "node:sqlite";
export { backup } from "./sqlite-backup.ts";
export type { SQLInputValue, SQLOutputValue } from "node:sqlite";

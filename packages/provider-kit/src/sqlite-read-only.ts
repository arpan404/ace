import { closeSync, openSync, readSync } from "node:fs";

// Bytes 18 and 19 of a SQLite header are the write and read format versions; 2 means WAL.
const walFormat = 2;

/**
 * A read-only connection to a WAL database needs its `-wal` file. Node's SQLite creates the
 * missing file itself; Bun's can create `-shm` but not `-wal`, so a database that was closed
 * cleanly (its `-wal` removed) fails to open with "unable to open database file". Create the
 * same empty `-wal` Node would, without ever truncating one that exists. Anything unusual
 * (no file, a URI, a read-only folder) is left for SQLite to report.
 */
export function prepareReadOnlyOpen(path: string): void {
  if (path === ":memory:" || path === "" || path.startsWith("file:")) return;
  try {
    const header = Buffer.alloc(20);
    const handle = openSync(path, "r");
    let read: number;
    try {
      read = readSync(handle, header, 0, header.length, 0);
    } finally {
      closeSync(handle);
    }
    if (read < header.length || header[18] !== walFormat || header[19] !== walFormat) return;
    closeSync(openSync(`${path}-wal`, "a"));
  } catch {
    // SQLite gives the real error when it opens the path.
  }
}

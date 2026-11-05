import { closeSync, fchmodSync, fchownSync, openSync, statSync } from "node:fs";

// SQLITE_CANTOPEN: "unable to open database file".
const cantOpen = 14;

/**
 * A read-only connection to a WAL database needs its `-wal` file. Node's SQLite creates a missing
 * one itself; Bun's creates `-shm` but not `-wal`, so a database closed cleanly (its `-wal`
 * removed) fails to open read-only with SQLITE_CANTOPEN. After such a failure, this creates the
 * empty `-wal` Node would, and says whether trying again can help.
 *
 * It never opens the database file: closing any descriptor of that file drops every POSIX lock
 * this process holds on it, live SQLite connections' included (sqlite.org/howtocorrupt.html).
 * `stat` takes no descriptor. The `-wal` is created exclusively, so an existing one is never
 * touched, with the database's mode and, when run as root, its owner, so `sudo ace doctor`
 * leaves a file the person's daemon can open. SQLite keeps no POSIX locks on the `-wal`.
 */
export function createMissingWal(path: string, error: unknown): boolean {
  if (path === ":memory:" || path === "" || path.startsWith("file:")) return false;
  if (!(error instanceof Error) || Reflect.get(error, "errcode") !== cantOpen) return false;
  try {
    const database = statSync(path);
    if (!database.isFile()) return false;
    const wal = openSync(`${path}-wal`, "wx", database.mode & 0o777);
    try {
      // The open's mode passes through the umask; the database's own mode is what SQLite uses.
      fchmodSync(wal, database.mode & 0o777);
      if (process.getuid?.() === 0) fchownSync(wal, database.uid, database.gid);
    } finally {
      closeSync(wal);
    }
    return true;
  } catch {
    // An existing -wal, a missing database or a read-only folder: the open's error stands.
    return false;
  }
}

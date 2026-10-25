import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SkillError } from "./skill-errors.ts";

/** Pause between attempts while another ace holds the lock; injected so tests control time. */
export type SkillLockWait = (milliseconds: number) => Promise<void>;
// A short, bounded wait: the request queue and the socket handler wait with it.
const attempts = 3;
const interval = 100;
const busy = (error: unknown) => {
  const code = error instanceof Error ? Reflect.get(error, "errcode") : undefined;
  // SQLITE_BUSY and SQLITE_LOCKED: another connection holds the lock.
  return code === 5 || code === 6;
};

/**
 * Serialize skill folder swaps across every ace on this machine (a release daemon and a dev one
 * share `~/.agents`). The lock is an IMMEDIATE transaction on a SQLite file beside the shared
 * state, like the plugin manager's `operation.sqlite`: the kernel drops it when its process dies,
 * so a crashed daemon never blocks the next. A busy lock is retried for about 300 ms without
 * blocking the thread, then answers `busy`.
 */
export async function withSkillLock<T>(
  path: string,
  wait: SkillLockWait,
  run: () => Promise<T>,
): Promise<T> {
  if ((await lstat(path).catch(() => undefined))?.isSymbolicLink())
    throw new SkillError("unavailable", "The skills lock is a symlink. Remove it and try again.");
  // `~/.agents` itself, as the skills CLI makes it; never its parents.
  await mkdir(dirname(path), { mode: 0o755 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const db = new DatabaseSync(path);
  try {
    // Nothing is ever written: no journal file beside the shared state, even in a read-only folder.
    db.exec("PRAGMA journal_mode=MEMORY");
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!busy(error)) throw error;
        if (attempt >= attempts)
          throw new SkillError("busy", "Another ace is updating skills. Try again in a moment.");
        await wait(interval);
      }
    }
    try {
      return await run();
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

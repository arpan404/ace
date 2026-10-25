import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { lstat } from "node:fs/promises";
import { SkillError } from "./skill-errors.ts";

/** Pause between attempts while another ace holds the lock; injected so tests control time. */
export type SkillLockWait = (milliseconds: number) => Promise<void>;
const attempts = 200;
const interval = 50;
const busy = (error: unknown) => {
  const code = error instanceof Error ? Reflect.get(error, "errcode") : undefined;
  // SQLITE_BUSY and SQLITE_LOCKED: another connection holds the lock.
  return code === 5 || code === 6;
};

/**
 * Serialize skill folder swaps across every ace on this machine (a release daemon and a dev one
 * share `~/.agents`). The lock is an IMMEDIATE transaction on a SQLite file beside the shared
 * state, like the plugin manager's `operation.sqlite`: the kernel drops it when its process dies,
 * so a crashed daemon never blocks the next. A busy lock is retried without blocking the thread.
 */
export async function withSkillLock<T>(
  path: string,
  wait: SkillLockWait,
  run: () => Promise<T>,
): Promise<T> {
  if ((await lstat(path).catch(() => undefined))?.isSymbolicLink())
    throw new SkillError("unavailable", "The skills lock is a symlink. Remove it and try again.");
  const db = new DatabaseSync(path);
  try {
    // Nothing is ever written: no journal file beside the shared state, even in a read-only folder.
    db.exec("PRAGMA journal_mode=MEMORY");
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!busy(error) || attempt >= attempts)
          throw new SkillError("unavailable", "Another ace is changing skills. Try again.");
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

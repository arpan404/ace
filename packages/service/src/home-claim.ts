import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { LiveHomeError } from "./home-format.ts";

/** Held while a home is renamed aside, so no daemon can take it in between. */
export interface HomeClaim {
  release(): void;
}

const LockOwner = z.looseObject({ pid: z.number().int().positive() });
// SQLITE_BUSY and SQLITE_LOCKED: another connection holds the lock.
const busyCodes = new Set([5, 6]);

function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** Whether a process with this pid exists (one we may not signal still exists). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM";
  }
}

/** The pid in the daemon's `daemon-lock` file, when there is a readable one. */
function lockOwner(root: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, "daemon-lock"), "utf8").slice(0, 256);
  } catch {
    return undefined;
  }
  try {
    const owner = LockOwner.safeParse(JSON.parse(text));
    return owner.success ? owner.data.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the lock database only when it is there: opening never creates one in the old home. */
function openLockDatabase(path: string): DatabaseSync | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
  // Loaded on first use: only a backup needs SQLite, and most callers never make one.
  return new (process.getBuiltinModule("node:sqlite").DatabaseSync)(path);
}

/**
 * Takes the old home's daemon lock the way the daemon does (an exclusive transaction on
 * `daemon-lock.sqlite`) and holds it until released, or throws `LiveHomeError` when a running
 * daemon holds it. Kernel locks end with their process, so a crashed daemon never blocks this.
 * A home without that database (an older layout) falls back to the pid in `daemon-lock`.
 */
export function claimHome(root: string, alive: (pid: number) => boolean = processAlive): HomeClaim {
  const database = openLockDatabase(join(root, "daemon-lock.sqlite"));
  if (database) {
    try {
      database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      return {
        release() {
          try {
            database.exec("ROLLBACK");
          } finally {
            database.close();
          }
        },
      };
    } catch (error) {
      database.close();
      const errcode = error instanceof Error ? Reflect.get(error, "errcode") : undefined;
      if (typeof errcode === "number" && busyCodes.has(errcode))
        throw new LiveHomeError(root, lockOwner(root));
      // Not a lock database this build knows; the pid below still decides.
    }
  }
  const pid = lockOwner(root);
  if (pid !== undefined && pid !== process.pid && alive(pid)) throw new LiveHomeError(root, pid);
  return { release() {} };
}

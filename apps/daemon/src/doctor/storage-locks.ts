import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Check } from "@ace/diagnostics";

const LockOwner = z.looseObject({ pid: z.number().int().positive() });

const FIX =
  "Nothing to remove by hand: start ace and it takes the lock over. If it still says another daemon owns the data folder, run ace triage.";

/**
 * The daemon's lock is an exclusive transaction on `daemon-lock.sqlite`, which the OS ends
 * with its process, so a crashed daemon never blocks the next one (local-files.ts). The
 * `daemon-lock` file beside it only names the holder, and the next daemon overwrites it.
 * So a file naming a dead pid is reported, never repaired.
 */
export function daemonLockCheck(dataDir: string, alive: (pid: number) => boolean): Check {
  return {
    id: "storage.locks",
    fix: FIX,
    async run() {
      const text = await readFile(join(dataDir, "daemon-lock"), "utf8").catch(() => undefined);
      if (text === undefined)
        return { status: "ok", message: "No daemon holds the data folder's lock", fix: FIX };
      let pid: number | undefined;
      try {
        const owner = LockOwner.safeParse(JSON.parse(text.slice(0, 256)));
        pid = owner.success ? owner.data.pid : undefined;
      } catch {
        pid = undefined;
      }
      if (pid === undefined)
        return {
          status: "ok",
          message: "The daemon lock note is unreadable; ace rewrites it when it next starts",
          fix: FIX,
        };
      if (alive(pid))
        return { status: "ok", message: `The daemon lock is held by pid ${pid}`, fix: FIX };
      return {
        status: "warn",
        message: `The daemon lock names pid ${pid}, which isn't running: ace stopped without releasing it. The lock itself ended with that process; only its note is left.`,
        fix: FIX,
      };
    },
  };
}

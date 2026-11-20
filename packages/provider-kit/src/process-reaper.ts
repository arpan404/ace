import { readFileSync } from "node:fs";
import { openLibrary, type NativeFunction } from "./bun-ffi.ts";
import { parseLinuxStat } from "./process-listing.ts";

/*
 * Linux: the daemon is a child subreaper (PR_SET_CHILD_SUBREAPER), so a process whose parent
 * exits is handed to the daemon instead of init and stays in its tree, where a shutdown finds
 * it. Those adopted processes become the daemon's zombies when they exit, and only the daemon
 * can reap them. The runtime reaps the children it spawned itself; reaping one of those would
 * steal its exit from the runtime, so a zombie is reaped only with proof it was adopted:
 *
 * - it was seen earlier with another parent (a process never changes parent except by
 *   adoption), or
 * - its process group is neither its own nor the daemon's: a process the daemon spawned starts
 *   in the daemon's group, or in its own when started detached, never in a third one.
 *
 * An adopted process that started its own session and was never seen with its first parent has
 * neither proof; its zombie stays until the daemon exits, a pid and nothing else.
 */

/** What the reaper knows about one of the daemon's zombie children. */
export type ZombieChild = { pid: number; group: number; seenWithParent?: number };

/** The zombie children `daemon` may reap: the ones proven adopted, never an owned group's leader. */
export function provenAdoptions(
  zombies: readonly ZombieChild[],
  daemon: { pid: number; group: number },
  owned: ReadonlySet<number>,
): number[] {
  return zombies
    .filter(
      (zombie) =>
        !owned.has(zombie.pid) &&
        ((zombie.seenWithParent !== undefined && zombie.seenWithParent !== daemon.pid) ||
          (zombie.group !== zombie.pid && zombie.group !== daemon.group)),
    )
    .map((zombie) => zombie.pid);
}

type Libc = Readonly<Record<"prctl" | "waitpid", NativeFunction>>;
let libc: Libc | undefined;
function linuxLibc(): Libc {
  libc ??= openLibrary("libc.so.6", {
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
  }).symbols;
  return libc;
}

/** PR_SET_CHILD_SUBREAPER in <linux/prctl.h>. */
const setChildSubreaper = 36;
/** WNOHANG in <sys/wait.h>. */
const noHang = 1;

/** Make this process a child subreaper. False where the platform or runtime can't. */
export function becomeSubreaper(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  try {
    return linuxLibc().prctl(setChildSubreaper, 1n, 0n, 0n, 0n) === 0;
  } catch {
    return false;
  }
}

/** This process's zombie children, with the group each was in. Linux only. */
export function zombieChildren(children: readonly number[]): ZombieChild[] {
  const zombies: ZombieChild[] = [];
  for (const pid of children) {
    try {
      const stat = parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (stat.state === "Z") zombies.push({ pid, group: stat.group });
    } catch {
      /* Reaped meanwhile. */
    }
  }
  return zombies;
}

/** Reap one proven-adopted zombie without blocking. True when it was reaped. */
export function reap(pid: number): boolean {
  try {
    return linuxLibc().waitpid(pid, new Int32Array(1), noHang) === pid;
  } catch {
    return false;
  }
}

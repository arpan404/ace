import { openLibrary, type NativeFunction } from "./bun-ffi.ts";
import type { ProcessListing } from "./process-listing.ts";

/*
 * Linux: the daemon is a child subreaper (PR_SET_CHILD_SUBREAPER), so a process whose parent
 * exits is handed to the daemon instead of init and stays in its tree, where a shutdown finds
 * it. Those adopted processes become the daemon's zombies when they exit, and only the daemon
 * can reap them. The runtime reaps the children it spawned itself; reaping one of those would
 * steal its exit from the runtime, so a zombie is reaped only with proof it was adopted:
 *
 * - it was seen earlier, with the same start time, under another parent (a process never
 *   changes parent except by adoption), or
 * - its process group is neither its own nor the daemon's: a process the daemon spawned starts
 *   in the daemon's group, or in its own when started detached, never in a third one.
 *
 * An adopted process that started its own session and was never seen with its first parent has
 * neither proof; its zombie stays until the daemon exits, a pid and nothing else.
 */

/** One of the daemon's zombie children, from one kernel read: its group and start time. */
export type ZombieChild = { pid: number; group: number; start: string };
/** What a watch saw of a process before it could have been adopted: its start, first parent. */
export type AdoptionEvidence = ReadonlyMap<number, { start: string; parent: number }>;

/**
 * The zombie children `daemon` may reap: the ones proven adopted, never an owned group's leader.
 * Evidence counts only for the same process: its pid AND start time, so a later child of the
 * runtime that reused a watched pid is never taken for the adopted one.
 */
export function provenAdoptions(
  zombies: readonly ZombieChild[],
  daemon: { pid: number; group: number },
  owned: ReadonlySet<number>,
  evidence: AdoptionEvidence,
): number[] {
  return zombies
    .filter((zombie) => {
      if (owned.has(zombie.pid)) return false;
      const seen = evidence.get(zombie.pid);
      if (seen?.start === zombie.start && seen.parent !== daemon.pid) return true;
      return zombie.group !== zombie.pid && zombie.group !== daemon.group;
    })
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

/** This process's zombie children, with the group and start each had. */
export function zombieChildren(
  children: readonly number[],
  listing: Pick<ProcessListing, "info">,
): ZombieChild[] {
  const zombies: ZombieChild[] = [];
  for (const pid of children) {
    const info = listing.info(pid);
    if (info?.zombie) zombies.push({ pid, group: info.group, start: info.start });
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

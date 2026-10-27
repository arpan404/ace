import { setTimeout as delay } from "node:timers/promises";
import type { Writable } from "node:stream";
import {
  processIdentity,
  windowsTreeRuntime,
  type WindowsProcessRecord,
  type WindowsTreeMember,
  type WindowsTreeRuntime,
} from "./process-identity.ts";
import type { ProcessExit } from "./process.ts";

/*
 * Windows only. A hidden console child ignores a polite taskkill, so closing its stdin is the
 * graceful stop. But a leader that exits on EOF before its descendants would orphan any the job
 * failed to contain, and taskkill /T cannot find a dead leader's tree. So the tree is recorded
 * (PID, creation time, owner) while the leader is alive, and every recorded root's surviving
 * descendants are ended and awaited before a stop resolves.
 */

export interface TreeStopRuntime {
  /** Creation time and owner of a live PID; undefined once it is gone. */
  identify(pid: number): { start: string; uid: string } | undefined;
  tree: WindowsTreeRuntime;
}

export const treeStopRuntime: TreeStopRuntime = {
  identify(pid) {
    const found = processIdentity(pid);
    return found && { start: found.start, uid: String(found.uid) };
  },
  tree: windowsTreeRuntime,
};

/** How long recorded survivors may take to die before the stop reports them. */
const survivorStopMs = 5_000;

export interface RecordedTree {
  /** Ends every recorded member still alive and resolves once none is left. */
  end(): Promise<void>;
}

/** Proven members of the tree, grown as live members are found to have started children. */
type Recorded = WindowsProcessRecord[];

function snapshot(pid: number, runtime: TreeStopRuntime): Recorded | undefined {
  try {
    const leader = runtime.identify(pid);
    if (!leader) return undefined;
    return runtime.tree.state([{ pid, ...leader }]).live;
  } catch {
    // Without a readable identity nothing can be proven ours; the tree stop stays in charge.
    return undefined;
  }
}

/**
 * Recorded members still alive, plus children they were proven to start since. A process whose
 * ancestry can no longer be proven is never ended: it may belong to someone else.
 */
function survivors(recorded: Recorded, runtime: TreeStopRuntime): WindowsTreeMember[] {
  const state = runtime.tree.state(recorded);
  recorded.push(...state.discovered);
  return state.live;
}

/** Record `pid`'s tree now, while its leader still names its descendants. */
export function recordTree(pid: number, runtime: TreeStopRuntime = treeStopRuntime): RecordedTree {
  const recorded = snapshot(pid, runtime);
  return {
    async end() {
      if (!recorded) return;
      const deadline = performance.now() + survivorStopMs;
      for (;;) {
        let left: WindowsTreeMember[];
        try {
          left = survivors(recorded, runtime);
        } catch {
          // An unreadable snapshot proves nothing either way; the job and tree stop remain.
          return;
        }
        if (left.length === 0) return;
        if (performance.now() >= deadline)
          throw new Error("Windows process tree survived its stop");
        for (const member of left) runtime.tree.terminate(member);
        await delay(25);
      }
    },
  };
}

/**
 * Stop a leader that ends itself on stdin EOF, then end and await whatever of its recorded tree
 * outlived it. Resolves only once no recorded member is alive.
 */
export async function stopTreeAfterEof(
  proc: {
    readonly pid?: number;
    stdin: Writable;
    stop(options?: { graceMs?: number }): Promise<ProcessExit>;
  },
  graceMs: number,
  runtime: TreeStopRuntime = treeStopRuntime,
): Promise<ProcessExit> {
  const tree = proc.pid === undefined ? undefined : recordTree(proc.pid, runtime);
  proc.stdin.end();
  const exit = await proc.stop({ graceMs });
  await tree?.end();
  return exit;
}

/**
 * Synchronously end this process's own descendants, for a host about to exit with no process
 * group to take them along. Members that will not die within the bound are left to the parent's
 * job and tree stop.
 */
export function endDescendantsSync(
  pid: number = process.pid,
  runtime: TreeStopRuntime = treeStopRuntime,
): void {
  const recorded = snapshot(pid, runtime);
  if (!recorded) return;
  const own = (member: WindowsTreeMember) => member.pid !== pid;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + survivorStopMs;
  try {
    for (;;) {
      const left = survivors(recorded, runtime).filter(own);
      if (left.length === 0 || performance.now() >= deadline) return;
      for (const member of left) runtime.tree.terminate(member);
      Atomics.wait(wait, 0, 0, 25);
    }
  } catch {
    /* Exiting anyway: the parent's job and tree stop remain the backstop. */
  }
}

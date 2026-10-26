import type { CleanupResult } from "@ace/provider-kit/cleanup";
import { createRetainedJob, type RetainedJob } from "@ace/provider-kit/process-containment";
import {
  processIdentity,
  windowsTreeRuntime,
  type WindowsTreeMember,
  type WindowsTreeRuntime,
} from "@ace/provider-kit/process-identity";

/**
 * Windows has no process groups. Each Git call ace starts there runs in its own Job Object
 * instead: the job is created before Git starts and Git joins it as soon as `spawn` returns, so
 * everything Git starts from then on is a member, and the kernel ends every member if the daemon
 * dies (kill-on-close). Git's first instructions run well after that point, and Git for Windows'
 * `cmd\git.exe` launcher waits for the Git it starts, so a process started before the join is
 * still a live descendant of the leader; stopping the call walks the leader's tree and joins
 * those too before ending the job. An empty job is the cleanup proof a POSIX call gets from its
 * process group being gone, and it retires the call's leases the same way.
 *
 * Loaded only on Windows (see `GitCli`).
 */
export interface GitJob {
  /** Joins the started leader; false when it can't, which leaves the taskkill route in charge. */
  adopt(pid: number): boolean;
  /** Git ended by itself: whatever it left running (an fsmonitor daemon) keeps running. */
  release(): void;
  /** Ends Git and every descendant, then resolves once nothing of the call is left alive. */
  stop(schedule: Schedule): Promise<CleanupResult>;
}
export type Schedule = (callback: () => void, milliseconds: number) => () => void;

/** The native edges, injectable for tests. */
export interface GitJobPorts {
  createJob: () => RetainedJob;
  tree: WindowsTreeRuntime;
  /** The leader's creation time and owner, or undefined once it has exited. */
  identify: (pid: number) => { start: string; uid: string } | undefined;
}

const defaultPorts: GitJobPorts = {
  createJob: () => createRetainedJob(),
  tree: windowsTreeRuntime,
  identify(pid) {
    const found = processIdentity(pid);
    return found && { start: found.start, uid: String(found.uid) };
  },
};

const pollMs = 50;
/** How long a stop waits for the job to empty before its receipt stays unconfirmed. */
const stopWaitMs = 10_000;
const sweepRounds = 5;

/** A stopped call whose job may still have members, by its leader's PID. */
interface Stopped {
  running(): boolean;
}
const stopped = new Map<number, Set<Stopped>>();

/**
 * Whether anything of a call ace stopped, led by `pid`, may still be alive. A PID no stopped call
 * was led by has nothing left: a call is forgotten only once its job was seen empty.
 */
export function jobAlive(pid: number): boolean {
  const calls = stopped.get(pid);
  if (!calls) return false;
  for (const call of calls) if (!call.running()) calls.delete(call);
  if (!calls.size) stopped.delete(pid);
  return calls.size > 0;
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    /* Best effort: the evidence check that follows decides. */
  }
}

/** A job for the next Git call, before it starts. Undefined when Windows can't create one. */
export function prepareJob(ports: GitJobPorts = defaultPorts): GitJob | undefined {
  let job: RetainedJob;
  try {
    job = ports.createJob();
  } catch {
    return undefined;
  }
  let leader: number | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    quietly(() => job.dispose());
  };
  // A spawn that throws or never gets a PID adopts nothing: don't hold the job until exit.
  queueMicrotask(() => {
    if (leader === undefined) close();
  });
  return {
    adopt(pid) {
      try {
        job.assign(pid);
        leader = pid;
        return true;
      } catch {
        close();
        return false;
      }
    },
    release() {
      if (closed) return;
      closed = true;
      try {
        job.release();
      } catch {
        quietly(() => job.dispose());
      }
    },
    stop(schedule) {
      if (leader === undefined || closed)
        return Promise.resolve({ status: "unconfirmed", reason: "Git never joined its job" });
      closed = true;
      return stopCall(job, leader, ports, schedule);
    },
  };
}

function stopCall(
  job: RetainedJob,
  pid: number,
  ports: GitJobPorts,
  schedule: Schedule,
): Promise<CleanupResult> {
  const identity = attempt(() => ports.identify(pid));
  const tree = identity && { pid, ...identity };
  // Descendants started before Git joined: join them, until a walk finds none it hadn't seen.
  const seen = new Set<number>();
  const outside: WindowsTreeMember[] = [];
  for (let round = 0; round < sweepRounds; round++) {
    if (!tree) break;
    const members = attempt(() => ports.tree.members(tree)) ?? [];
    const fresh = members.filter((member) => !seen.has(member.pid));
    if (!fresh.length) break;
    for (const member of fresh) {
      seen.add(member.pid);
      try {
        job.assign(member.pid);
      } catch {
        outside.push(member);
      }
    }
  }
  quietly(() => job.terminate());
  for (const member of outside) quietly(() => ports.tree.terminate(member));

  let settled = false;
  /** Whether anything of the call is alive, ending any descendant still outside the job. */
  const running = (): boolean => {
    if (settled) return false;
    const members = attempt(() => job.activeCount());
    if (members === undefined || members > 0) return true;
    if (tree) {
      const left = attempt(() => ports.tree.members(tree));
      if (left === undefined) return true;
      if (left.length) {
        for (const member of left) quietly(() => ports.tree.terminate(member));
        return true;
      }
    }
    settled = true;
    quietly(() => job.dispose());
    return false;
  };
  const call: Stopped = { running };
  const calls = stopped.get(pid) ?? new Set<Stopped>();
  calls.add(call);
  stopped.set(pid, calls);

  return new Promise((resolve) => {
    let waited = 0;
    const check = () => {
      if (!running()) {
        resolve({
          status: "confirmed",
          evidence: `The Windows job holding Git process ${pid} is empty${
            tree ? " and no process it started is alive" : ""
          }`,
        });
        return;
      }
      if (waited >= stopWaitMs) {
        // The job stays open: kill-on-close still ends it with the daemon, and lease checks
        // keep asking it (see `jobAlive`) until it is empty.
        resolve({ status: "unconfirmed", reason: `Git process ${pid}'s job is not empty yet` });
        return;
      }
      waited += pollMs;
      schedule(check, pollMs);
    };
    check();
  });
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

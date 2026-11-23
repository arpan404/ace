import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { systemListing, type ProcessListing } from "@ace/provider-kit/process-listing";
import { provenAdoptions, reap, zombieChildren } from "@ace/provider-kit/process-reaper";
import { captureTree, type CapturedMember } from "@ace/provider-kit/process-tree";
import { childGroup, type LeaderGroup } from "@ace/provider-kit/leader-group";
import { newGroupToken, withGroupToken } from "@ace/provider-kit/group-token";
import { developerToolsGit } from "./git-binary.ts";
import { processGroupAlive, scanGitProcesses } from "./git-processes.ts";
import type { GitProcessRuntime } from "./types.ts";

export function processRuntime(overrides: Partial<GitProcessRuntime> = {}): GitProcessRuntime {
  return {
    spawn: spawnGitProcess,
    scheduleTimeout: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    platform: process.platform,
    signalGroup: signalSpawnedGroup,
    groupAlive: (pid, child) => (child && groups.get(child)?.running()) ?? processGroupAlive(pid),
    gitProcesses: scanGitProcesses(overrides.platform ?? process.platform),
    locateGit: (env) => developerToolsGit(overrides.platform ?? process.platform, env),
    fileClock: () => Date.now(),
    ...overrides,
  };
}
function piped(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}
/**
 * The groups of detached Git children this isolate spawned, by the child itself, never by pid: a
 * pid may by now be a newer child's. Each is signalled by number only while its leader is
 * unreaped, then member by member (`leader-group.ts`).
 */
const groups = new WeakMap<ChildProcess, LeaderGroup>();

/**
 * Signal a group this isolate spawned; anything else is refused, never signalled by number. A
 * group signal that is refused (a worker that can't prove the group to the main isolate) falls
 * back to the child's own handle, which can't reach a reused pid while we hold it unreaped.
 */
function signalSpawnedGroup(pid: number, signal: NodeJS.Signals, child?: ChildProcess): void {
  const group = child && groups.get(child);
  if (!child || !group || group.leader !== pid)
    throw new Error(`Process group ${pid} is not one this process spawned`);
  group.signal(signal).catch((error: unknown) => {
    process.emitWarning(`Could not signal Git's process group ${pid}: ${String(error)}`);
    try {
      child.kill(signal);
    } catch {
      /* Already gone. */
    }
  });
}

/** Node's three-pipe overload does not describe additional inherited descriptors. Check the edge. */
export function spawnGitProcess(
  command: string,
  args: string[],
  options: Parameters<GitProcessRuntime["spawn"]>[2],
): ChildProcessWithoutNullStreams {
  const token = options.detached && process.platform !== "win32" ? newGroupToken() : undefined;
  const child = spawn(
    command,
    args,
    token === undefined
      ? options
      : { ...options, env: withGroupToken(options.env ?? process.env, token) },
  );
  const pid = child.pid;
  if (pid !== undefined && token !== undefined) {
    const group = childGroup(pid, token, child);
    groups.set(child, group);
    // First of all exit listeners: once reaped its group number is never signalled.
    child.once("exit", () => group.reaped());
  }
  if (!piped(child)) {
    child.kill("SIGKILL");
    throw new Error("Git requires three owned pipes");
  }
  return child;
}

/**
 * Resolves once the process group `pid` led has no live members, or after `ms` (bounded:
 * a member that cannot be killed must not hold its caller forever). On Windows it returns at
 * once: there is no process group to watch, and the tree is ended by the call's job or by
 * `taskkill /T` (which cannot prove an escaped descendant gone).
 */
export async function groupGone(
  runtime: GitProcessRuntime,
  pid: number | undefined,
  child?: ChildProcess,
  ms = 3_000,
): Promise<void> {
  if (!pid || runtime.platform === "win32") return;
  const step = 15;
  for (let waited = 0; waited < ms; waited += step) {
    try {
      if (!runtime.groupAlive(pid, child)) return;
    } catch {
      return;
    }
    await new Promise<void>((resolve) => runtime.scheduleTimeout(resolve, step));
  }
}

export function killTree(
  runtime: GitProcessRuntime,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // The leader exited, but a member it started (a helper holding Git's pipes) can live on in
    // its group. Its leader group signals those members by identity, never the freed number.
    // An exited leader on Windows has no group to name; a member that left the group (setsid)
    // is outside what any of this can reach.
    if (child.pid && runtime.platform !== "win32" && runtime.groupAlive(child.pid, child)) {
      try {
        runtime.signalGroup(child.pid, "SIGKILL", child);
      } catch {
        // Gone between the check and the signal.
      }
    }
    return Promise.resolve();
  }
  if (child.pid && runtime.platform === "win32") {
    // Windows has no POSIX process groups. Request descendant termination;
    // taskkill cannot prove containment of escaped writers.
    return new Promise<void>((resolve) => {
      const killer = runtime.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        // A bare name is searched in the working directory first: on a Windows host, System32.
        ...(process.platform === "win32"
          ? { cwd: join(process.env.SystemRoot ?? "C:\\Windows", "System32") }
          : {}),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      killer.stdout.on("error", () => {});
      killer.stderr.on("error", () => {});
      killer.stdin.on("error", () => {});
      killer.stdin.end();
      killer.stdout.resume();
      killer.stderr.resume();
      const finish = () => {
        killer.stdin.destroy();
        killer.stdout.destroy();
        killer.stderr.destroy();
        killer.unref();
        resolve();
      };
      const cancel = runtime.scheduleTimeout(() => {
        killer.kill("SIGKILL");
        child.kill("SIGKILL");
        finish();
      }, 10_000);
      killer.once("error", () => {
        cancel();
        child.kill("SIGKILL");
        finish();
      });
      killer.once("close", (code) => {
        cancel();
        if (code !== 0) child.kill("SIGKILL");
        resolve();
      });
    }).catch(() => {
      child.kill("SIGKILL");
    });
  } else if (child.pid) {
    // Linux: read the tree while every member's parent still lives, the proof that reaps them.
    let members: CapturedMember[] = [];
    try {
      if (runtime.platform === "linux") members = captureTree([child.pid]).members;
    } catch {
      // Unread, the kill still goes ahead; its orphans then stay as harmless zombies.
    }
    try {
      runtime.signalGroup(child.pid, "SIGKILL", child);
    } catch {
      child.kill("SIGKILL");
    }
    if (members.length) void reapOrphans(members, runtime.scheduleTimeout).catch(() => {});
  } else child.kill("SIGKILL");
  return Promise.resolve();
}

/**
 * Reaps the members of a killed group that became this process's zombies. The kernel hands a
 * member whose parent died first to the nearest child subreaper, which on Linux is the daemon,
 * and only the daemon can reap it. `members` was captured before the kill: a parent other than
 * this process proves the zombie was adopted, so a child the runtime started itself is never
 * reaped (`provenAdoptions`). Bounded; what is left stays a zombie, which `processGroupAlive`
 * already counts as gone.
 */
async function reapOrphans(
  members: readonly CapturedMember[],
  schedule: GitProcessRuntime["scheduleTimeout"],
  listing: ProcessListing = systemListing,
  attempts = 40,
): Promise<void> {
  const evidence = new Map(members.map(({ pid, start, parent }) => [pid, { start, parent }]));
  const self = { pid: process.pid };
  for (let attempt = 0; attempt < attempts && evidence.size; attempt++) {
    const zombies = zombieChildren(listing.lister()(self.pid), listing);
    for (const pid of provenAdoptions(zombies, self, new Set(), evidence))
      if (reap(pid)) evidence.delete(pid);
    // Gone without becoming ours (init or another subreaper took it): nothing to reap.
    for (const [pid, seen] of evidence)
      if (listing.info(pid)?.start !== seen.start) evidence.delete(pid);
    if (evidence.size) await new Promise<void>((resolve) => schedule(resolve, 25));
  }
}

/** Drain the owned leader without waiting for inherited pipes or claiming containment. */
export function drainProcessExit(
  child: ChildProcessWithoutNullStreams,
  schedule: GitProcessRuntime["scheduleTimeout"],
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let cancel: (() => void) | undefined;
    const finish = () => {
      cancel?.();
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    // Shutdown remains bounded even if a supervisor or the OS cannot stop the
    // leader. Durable quarantine and its cleanup receipt remain independent.
    cancel = schedule(finish, 1000);
  });
}

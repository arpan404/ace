// SPDX-License-Identifier: Apache-2.0

/**
 * The native core shell (G2 owns the port): the JS half of the port bridge
 * plus the dispatch for the process layer (G2a), ordering and leases (G2b),
 * and policy and configuration (G2c). G0 stub: every call probes the addon
 * and defers to the same TypeScript it replaces.
 *
 * The bridge (G2a fills the core side): each `GitProcessRuntime` member the
 * caller injected is passed to the core as a callback, and an injected
 * `spawn` is wrapped so its `ChildProcess` streams stdin, stdout and stderr
 * chunks and the exit (with the pid) to the core through one ordered queue,
 * as ADR 0223 §7's rule 3 orders a session's events.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { GitPart } from "@ace/provider-kit/native-switches";
import { gitAddon, runNativeOp, runNativeOpSync } from "./native-common.ts";
import type { GitProcessRuntime } from "./types.ts";

const part = "core" satisfies GitPart;

/** Dispatches one core operation to the native core when the part is on. */
export function runNativeCore<T>(op: string, typescript: () => Promise<T>): Promise<T> {
  return runNativeOp(part, op, typescript);
}

/** The synchronous `runNativeCore`, for the calls that stay synchronous. */
export function runNativeCoreSync<T>(op: string, typescript: () => T): T {
  return runNativeOpSync(part, op, typescript);
}

/**
 * The injected `GitProcessRuntime` members as core callbacks: the port
 * surface the core calls back on the JS thread. G2a wraps the defaults and
 * bridges the injected members; G0 passes them through.
 */
export function portCallbacks(runtime: GitProcessRuntime): GitProcessRuntime {
  return {
    spawn: runtime.spawn,
    scheduleTimeout: runtime.scheduleTimeout,
    platform: runtime.platform,
    signalGroup: runtime.signalGroup,
    groupAlive: runtime.groupAlive,
    gitProcesses: runtime.gitProcesses,
    locateGit: runtime.locateGit,
    fileClock: runtime.fileClock,
    ...(runtime.cleanupSupervisor === undefined
      ? {}
      : { cleanupSupervisor: runtime.cleanupSupervisor }),
  };
}

/** One ordered bridge event the shell feeds the core. */
export type GitBridgeEventKind = "stdin-ack" | "stdout" | "stderr" | "exit" | "close";

/** An injected spawn bridged to the core: the queue the core drains in order. */
export interface BridgedSpawn {
  /** The leader's pid, once the spawn gave one. */
  readonly pid: number | undefined;
  /** Takes every queued event, in arrival order. */
  drain(): string[];
  /** Queues stdin bytes for the leader; the pump writes them in order. */
  writeStdin(data: Uint8Array): void;
  /** Closes stdin; a CLI waiting on it exits instead of hanging. */
  endStdin(): void;
  /** Releases the queue; the tree stays as the exit left it. */
  close(): void;
}

/**
 * Wraps an injected `spawn`'s `ChildProcess` so the core reads it as it
 * reads a supervised child: stdin, stdout and stderr chunks and the exit
 * (with the pid) through one ordered queue. Binary chunks cross base64.
 */
export function bridgeInjectedSpawn(child: ChildProcessWithoutNullStreams): BridgedSpawn {
  const bridge = new (gitAddon().GitPortBridge)();
  const push = (kind: GitBridgeEventKind, payload: Record<string, unknown>): void => {
    void bridge.pushEvent(JSON.stringify({ kind, ...payload }));
  };
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    push("stdout", { data: chunk.toString("base64") });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    push("stderr", { data: chunk.toString("base64") });
  });
  child.once("exit", (code, signal) => {
    push("exit", { code, signal, pid: child.pid });
  });
  child.once("close", (code, signal) => {
    push("close", { code, signal, pid: child.pid });
  });
  return {
    pid: child.pid ?? undefined,
    drain: () => bridge.drain(),
    writeStdin: (data: Uint8Array) => {
      void child.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      push("stdin-ack", { bytes: data.byteLength });
    },
    endStdin: () => {
      child.stdin.end();
    },
    close: () => {
      bridge.close();
    },
  };
}

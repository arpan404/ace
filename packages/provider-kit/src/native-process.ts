// SPDX-License-Identifier: Apache-2.0
/**
 * The native supervisor shell behind `ACE_SUPERVISOR=native` (E2a). The
 * TypeScript orchestration (spawns, stops, journals, sweeps) stays where it
 * is; this shell serves the OS primitives it runs on: spawning a child that
 * quacks like node:child_process behind the same events, kernel containment
 * for Windows trees, and the inventory and escapee journals over the store's
 * SQLite connection. TS callers don't change: each replaced function picks
 * this backend with one `if` on `supervisorBackend()`.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { supervisorBackend } from "./native-switches.ts";

/** A byte event from the native child, in arrival order. */
export type SupervisorEventKind = "stdout" | "stderr" | "exit" | "close" | "stdin-error";
export type SupervisorEventHandler = (
  error: unknown,
  kind: SupervisorEventKind,
  data: Uint8Array,
) => void;

interface NativeChildHandle {
  pid(): number | null | undefined;
  writeStdin(data: Uint8Array): void;
  endStdin(): void;
  jobRunning(): boolean | null | undefined;
  jobTerminate(): void;
  dispose(): void;
}

interface NativeInventoryHandle {
  add(pid: number, name: string, cwd?: string | undefined): void;
  remove(pid: number): string;
  retryRemovals(nowMs: number): string;
  retryAtMs(): number | null | undefined;
  recover(): string;
  list(): string;
  takeReports(): string[];
  close(): void;
  windowsTick(nowMs: number): boolean;
}

interface NativeJournalHandle {
  record(membersJson: string): void;
  forget(membersJson: string): void;
  earlier(): string;
  keep(pid: number, start: string): void;
  recordLineage(uniques: string[]): void;
  forgetEarlierLineage(): void;
  kept(): string;
  close(): void;
}

interface NativeJobHandle {
  assign(pid: number): void;
  running(): boolean | null | undefined;
  terminate(): void;
  dispose(): void;
}

interface SupervisorAddon {
  supervisorSpawn(specJson: string, events: SupervisorEventHandler): NativeChildHandle;
  NativeInventory: new (path: string) => NativeInventoryHandle;
  NativeJournal: new (path: string, run: string) => NativeJournalHandle;
  NativeJob: new () => NativeJobHandle;
  supervisorReadOwnership(path: string, run?: string): string;
  supervisorReadOwnedGroups(path: string, ownerPid: number, ownerStart: string): string;
  supervisorWindowsTreeRecorded(path: string, leaderJson: string): boolean;
  supervisorProcessIdentity(pid: number): string | null;
  supervisorProcessGroupIsGone(group: number): boolean;
  supervisorKillGroup(group: number, signal: string): void;
  supervisorKillProcess(pid: number, signal: string): boolean;
  supervisorKillWindowsTree(pid: number, force: boolean): void;
  supervisorSignalMember(memberJson: string, signal: string): string;
  supervisorCaptureTree(rootsJson: string, limit: number): string;
  supervisorStopMembers(
    membersJson: string,
    graceMs: number,
    deadlineMs: number | undefined,
    done: (error: unknown, leftJson: string) => void,
  ): void;
  supervisorTreeState(recordedJson: string): string;
  supervisorTreeTerminate(memberJson: string): string;
  supervisorTerminateDirectoryProcesses(
    directoriesJson: string,
    selfPid: number,
    done: (error: unknown, outcome: string) => void,
  ): void;
  supervisorToWindowsCommand(command: string, args: string[]): string;
  supervisorWindowsSystemExecutable(name: string): string;
  supervisorLeaveProcessGroup(): boolean;
  supervisorBecomeSubreaper(): boolean;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_SUPERVISOR_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_SUPERVISOR_ADDON ?? process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: SupervisorAddon | undefined;
function addon(): SupervisorAddon {
  if (loaded) return loaded;
  if (supervisorBackend() !== "native") throw new Error("Native supervisor is off");
  const path = addonPath();
  if (!existsSync(path))
    throw new Error(
      `ACE_SUPERVISOR=native needs the supervisor addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting the classes and functions
  // `ace-daemon-node/src/supervisor.rs` declares.
  loaded = module.exports as unknown as SupervisorAddon;
  return loaded;
}

/** The native addon for the supervisor E2a surface. */
export function supervisorAddon(): SupervisorAddon {
  return addon();
}

/** How a standard stream is attached, matching the shell's spawn options. */
export type NativeStdioMode = "piped" | "ignore" | "inherit" | "stderr";

/**
 * What the shell's spawn orchestration drives: a pid, piped streams, error,
 * exit and close events, and a direct kill for the tree-signal fallback.
 */
export interface SpawnedChild {  readonly pid?: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * What a byte-stream spawn drives: a pid, piped byte streams, error, exit
 * and close events, and a direct kill for the tree-signal fallback.
 */
export interface SpawnedBytes {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * What an inherited-stdio spawn drives: a pid and error, exit and close
 * events. Streams stay with the terminal.
 */
export interface SpawnedHandle {
  readonly pid?: number | undefined;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/** What the native child is spawned with; the shell maps commands first. */
export interface NativeSpawnSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: [name: string, value: string][];
  windows: boolean;
  clearEnv: boolean;
  stdin: NativeStdioMode;
  stdout: NativeStdioMode;
  stderr: NativeStdioMode;
  verbatim: boolean;
  /** The waiter ends stragglers on a natural exit; the shell clears it when it drives stops. */
  waiterDestroy: boolean;
}

/** A masked (undefined) variable isn't launched, like node's spawn. */
export function launchEnv(env: NodeJS.ProcessEnv): [name: string, value: string][] {
  const pairs: [name: string, value: string][] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}

/** The leader's end, as JSON: a code, a signal name, or nulls. */
function parseExit(data: Uint8Array): { code: number | null; signal: string | null } {
  return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString()) as {
    code: number | null;
    signal: string | null;
  };
}

/** A readable that is already ended: stdio the shell never observes. */
function endedReadable(): Readable {
  const stream = new Readable({ read: () => {} });
  // Ends on its own turn, like an inherited or ignored standard stream.
  queueMicrotask(() => stream.push(null));
  return stream;
}

/**
 * A native child that quacks like node:child_process behind the same
 * events: `error` then `close` on a failed spawn, `exit` and `close` when
 * the process and its pipes are done. The shell feeds its streams; the
 * callers' orchestration (leases, gates, stops) runs unchanged on top.
 */
export class NativeChildProcess extends EventEmitter implements SpawnedChild, SpawnedBytes, SpawnedHandle {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly handle: NativeChildHandle | undefined;
  private readonly failure: Error | undefined;

  constructor(spec: NativeSpawnSpec) {
    super();
    let handle: NativeChildHandle | undefined;
    let failure: Error | undefined;
    try {
      handle = addon().supervisorSpawn(
        JSON.stringify({
          command: spec.command,
          args: [...spec.args],
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          env: spec.env.map(([name, value]) => [name, value]),
          windows: spec.windows,
          clear_env: spec.clearEnv,
          stdin: spec.stdin,
          stdout: spec.stdout,
          stderr: spec.stderr,
          verbatim: spec.verbatim,
          retained: false,
          waiter_destroy: spec.waiterDestroy,
        }),
        // napi calls threadsafe functions error-first: (null, kind, data).
        (_error: unknown, kind, data) => this.onEvent(kind, data),
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    this.handle = handle;
    this.failure = failure;
    const pid = handle?.pid();
    this.pid = typeof pid === "number" && Number.isSafeInteger(pid) ? pid : undefined;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.handle) {
          callback(new Error("supervisor stdin is closed"));
          return;
        }
        try {
          this.handle.writeStdin(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final: (callback) => {
        try {
          this.handle?.endStdin();
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    // A failed spawn surfaces like node's: `error`, then `close`, no `exit`.
    if (spec.stdout === "inherit" || spec.stdout === "ignore") {
      this.stdout = endedReadable();
    } else {
      this.stdout = new Readable({ read: () => {} });
    }
    if (spec.stderr === "inherit" || spec.stderr === "ignore") {
      this.stderr = endedReadable();
    } else {
      this.stderr = new Readable({ read: () => {} });
    }
    if (failure) {
      queueMicrotask(() => {
        this.emit("error", failure);
        // A failed spawn destroys its stdio like node's does, so line
        // interfaces built on them close instead of hanging.
        this.stdout.destroy();
        this.stderr.destroy();
        this.emit("close", -2, null);
      });
    }
  }

  private onEvent(kind: SupervisorEventKind, data: Uint8Array): void {
    if (kind === "stdout" || kind === "stderr") {
      const stream = kind === "stdout" ? this.stdout : this.stderr;
      stream?.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (kind === "stdin-error") {
      const error = new Error(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString());
      // A closed reader surfaces the failure the way node's does.
      this.stdin.destroy(error);
      return;
    }
    if (kind === "exit") {
      const exit = parseExit(data);
      this.emit("exit", exit.code, exit.signal);
      return;
    }
    if (kind === "close") {
      const exit = parseExit(data);
      this.stdout?.push(null);
      this.stderr?.push(null);
      this.emit("close", exit.code, exit.signal);
    }
  }

  /** Ends the leader itself, ESRCH-safe: the fallback when a tree signal cannot run. */
  kill(signal: NodeJS.Signals): boolean {
    if (this.pid === undefined) return false;
    try {
      return addon().supervisorKillProcess(this.pid, signal);
    } catch {
      return false;
    }
  }

  /** Releases tasks and pipes; the tree stays as the exit left it. */
  dispose(): void {
    try {
      this.handle?.dispose();
    } catch {
      /* Best effort during process exit. */
    }
  }
}

/** Spawns a supervised child; byte events arrive in arrival order. */
export function nativeSpawnChild(spec: NativeSpawnSpec): NativeChildProcess {
  return new NativeChildProcess(spec);
}

/** Kernel containment for one Windows tree behind the TypeScript job shape. */
export function nativeJobFactory(): import("./process-containment.ts").WindowsJob | undefined {
  try {
    const job = addon().NativeJob ? new (addon().NativeJob)() : undefined;
    if (!job) return undefined;
    return {
      assign: (pid: number) => job.assign(pid),
      running: () => job.running() ?? undefined,
      terminate: () => job.terminate(),
      dispose: () => job.dispose(),
    };
  } catch {
    // Any failure leaves the taskkill tree stop in charge.
    return undefined;
  }
}

/** Whole-tree stop on Windows, where process groups do not exist. */
export function nativeKillWindowsTree(pid: number, force: boolean): void {
  try {
    addon().supervisorKillWindowsTree(pid, force);
  } catch (error) {
    // A missing System32 throws, like the TypeScript binding; a failed
    // spawn only warns, and the caller's stop fails on its own timer.
    if (error instanceof Error && error.message.includes("system directory")) throw error;
    process.emitWarning(`taskkill could not run for process ${pid}: ${(error as Error).message}`);
  }
}

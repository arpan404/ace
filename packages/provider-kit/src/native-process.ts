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
export type SupervisorEventKind =
  | "stdout"
  | "stderr"
  | "stdout-end"
  | "stderr-end"
  | "exit"
  | "close"
  | "stdin-written"
  | "hold-limit"
  | "held"
  | "stdin-error";
/** For output, returns whether the stream wants more: false pauses the native pump. */
export type SupervisorEventHandler = (
  error: unknown,
  kind: SupervisorEventKind,
  data: Uint8Array,
) => boolean | undefined;

interface NativeChildHandle {
  pid(): number;
  writeStdin(data: Uint8Array): void;
  endStdin(): void;
  abortStdin(): void;
  resumeOutput(kind: "stdout" | "stderr"): void;
  closeOutput(kind: "stdout" | "stderr"): void;
  kill(signal: string): boolean;
  signalGroup(signal: string): "sent" | "gone" | "released";
  groupGone(): boolean;
  hold(): boolean;
  unhold(): void;
  disown(): void;
  leaderStart(): string | null | undefined;
  hasJob(): boolean;
  jobRunning(): boolean | null | undefined;
  jobTerminate(): void;
  jobDispose(): void;
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

interface SupervisorAddon {
  supervisorSpawn(specJson: string, events: SupervisorEventHandler): NativeChildHandle;
  NativeInventory: new (path: string) => NativeInventoryHandle;
  NativeJournal: new (path: string, run: string) => NativeJournalHandle;
  supervisorReadOwnership(path: string, run?: string): string;
  supervisorReadOwnedGroups(path: string, ownerPid: number, ownerStart: string): string;
  supervisorWindowsTreeRecorded(path: string, leaderJson: string): boolean;
  supervisorProcessIdentity(pid: number): string | null;
  supervisorProcessGroupIsGone(group: number): boolean;
  supervisorHoldGroup(group: number, start: string): boolean;
  supervisorUnholdGroup(group: number, start: string): void;
  supervisorSignalGroup(group: number, start: string, signal: string): string;
  supervisorGroupGone(group: number, start: string): boolean;
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
export interface SpawnedChild {
  readonly pid?: number | undefined;
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

/**
 * What the native child is spawned with; the shell maps commands first. `env` is the child's
 * whole environment, as node's spawn takes it: nothing else of the daemon's is inherited.
 */
export interface NativeSpawnSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: [name: string, value: string][];
  stdin: NativeStdioMode;
  stdout: NativeStdioMode;
  stderr: NativeStdioMode;
  verbatim: boolean;
  /** Windows: no console window, like `windowsHide`. */
  hide: boolean;
  /** Windows: the child joins a kill-on-close job before it runs (the shell's own job). */
  contain: boolean;
  /** The process's output budget: what the native pumps read ahead never exceeds it. */
  maxOutputBytes?: number;
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
 * A native child that quacks like node:child_process behind the same events: `error` then
 * `close` on a failed spawn, `exit` once the leader exits (whoever still holds its pipes) and
 * `close` when the pipes are done. Output keeps node's flow: a full stream pauses the native
 * pump and a destroyed one stops it; a stdin write's callback runs once the bytes are in the
 * pipe, and EOF follows every write. The callers' orchestration (leases, gates, stops) runs
 * unchanged on top.
 */
export class NativeChildProcess
  extends EventEmitter
  implements SpawnedChild, SpawnedBytes, SpawnedHandle
{
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly handle: NativeChildHandle | undefined;
  /** The callback of the one write in flight (a Writable writes one at a time). */
  private written: ((error?: Error | null) => void) | undefined;

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
          stdin: spec.stdin,
          stdout: spec.stdout,
          stderr: spec.stderr,
          verbatim: spec.verbatim,
          hide: spec.hide,
          contain: spec.contain,
          ...(spec.maxOutputBytes === undefined ? {} : { max_output_bytes: spec.maxOutputBytes }),
        }),
        // napi calls threadsafe functions error-first: (null, kind, data).
        (_error: unknown, kind, data) => this.onEvent(kind, data),
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    this.handle = handle;
    const pid = handle?.pid();
    this.pid = typeof pid === "number" && Number.isSafeInteger(pid) ? pid : undefined;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (!this.handle) {
          callback(new Error("supervisor stdin is closed"));
          return;
        }
        try {
          this.handle.writeStdin(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          this.written = callback;
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final: (callback) => {
        try {
          // Queued after every write, so EOF never overtakes one.
          this.handle?.endStdin();
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      destroy: (error, callback) => {
        this.handle?.abortStdin();
        callback(error);
      },
    });
    this.stdout = spec.stdout === "piped" ? this.pipedOutput("stdout") : endedReadable();
    this.stderr = spec.stderr === "piped" ? this.pipedOutput("stderr") : endedReadable();
    // A failed spawn surfaces like node's: `error`, then `close`, no `exit`.
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

  /** A piped output: reading resumes the native pump, destroying stops it. */
  private pipedOutput(kind: "stdout" | "stderr"): Readable {
    return new Readable({
      read: () => {
        try {
          this.handle?.resumeOutput(kind);
        } catch {
          /* The child is already released. */
        }
      },
      destroy: (error, callback) => {
        try {
          this.handle?.closeOutput(kind);
        } catch {
          /* The child is already released. */
        }
        callback(error);
      },
    });
  }

  private onEvent(kind: SupervisorEventKind, data: Uint8Array): boolean | undefined {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (kind === "stdout" || kind === "stderr") {
      // False pauses the native pump until the stream reads again.
      return (kind === "stdout" ? this.stdout : this.stderr).push(bytes);
    }
    if (kind === "stdout-end" || kind === "stderr-end") {
      // Each stream ends at its own EOF, like a node socket.
      (kind === "stdout-end" ? this.stdout : this.stderr).push(null);
      return undefined;
    }
    if (kind === "hold-limit") {
      // Given up and still occupied at the hold limit: killed through the daemon's guard.
      holdLimitHandler?.(this);
      return undefined;
    }
    if (kind === "held") {
      process.emitWarning(bytes.toString());
      return undefined;
    }
    if (kind === "stdin-written") {
      const written = this.written;
      this.written = undefined;
      written?.();
      return undefined;
    }
    if (kind === "stdin-error") {
      const error = new Error(bytes.toString());
      const written = this.written;
      this.written = undefined;
      // A closed reader surfaces the failure the way node's does.
      if (written) written(error);
      else this.stdin.destroy(error);
      return undefined;
    }
    const exit = parseExit(data);
    if (kind === "exit") {
      // Every listener runs, the shell's tree cleanup included, even when an earlier one throws;
      // the first throw still surfaces, after them all.
      let thrown: { error: unknown } | undefined;
      // `once` wrappers remove themselves when called, as `emit` would remove them.
      for (const listener of this.rawListeners("exit") as ((...args: unknown[]) => unknown)[]) {
        try {
          listener.call(this, exit.code, exit.signal);
        } catch (error) {
          thrown ??= { error };
        }
      }
      // Like node's flushStdio: once the leader exits, a stream nobody reads is drained, so its
      // EOF (and `close`) can arrive.
      process.nextTick(() => this.drainUnread());
      if (thrown) throw thrown.error;
      return undefined;
    }
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("close", exit.code, exit.signal);
    return undefined;
  }

  /** Resumes each piped stream that has no reader, discarding its bytes, as node does at exit. */
  private drainUnread(): void {
    for (const stream of [this.stdout, this.stderr]) {
      if (
        stream.readable &&
        stream.readableFlowing === null &&
        stream.listenerCount("data") === 0 &&
        stream.listenerCount("readable") === 0
      )
        stream.resume();
    }
  }

  /**
   * Signals the child's process group while its id is provably the one ace created; once the
   * supervisor has released the leader (its group emptied) nothing is sent.
   */
  signalGroup(signal: NodeJS.Signals): void {
    if (!this.handle) return;
    this.handle.signalGroup(signal);
  }

  /** Whether nothing of the child's group runs any more. */
  groupGone(): boolean {
    return this.handle ? this.handle.groupGone() : true;
  }

  /** Starts a stop: true while the group number is still this tree's (until `unhold`). */
  hold(): boolean {
    return this.handle?.hold() ?? false;
  }

  /** Ends a stop started with `hold`. */
  unhold(): void {
    this.handle?.unhold();
  }

  /** The owner gave the group up: the native hold limit starts. */
  disown(): void {
    this.handle?.disown();
  }

  /** The leader's kernel start, read at spawn. */
  leaderStart(): string | undefined {
    return this.handle?.leaderStart() ?? undefined;
  }

  /** Spawned by the native supervisor, which holds (or held) its leader. */
  readonly spawned = true;

  /** Signals the leader through its own handle; false once it is reaped, never a reused pid. */
  kill(signal: NodeJS.Signals): boolean {
    try {
      return this.handle?.kill(signal) ?? false;
    } catch {
      return false;
    }
  }

  /** The kernel job the child joined before it ran (Windows), as the shell's job shape. */
  job(): import("./process-containment.ts").WindowsJob | undefined {
    const handle = this.handle;
    if (!handle?.hasJob()) return undefined;
    return {
      // Joined at spawn, while it was still suspended.
      assign: () => {},
      running: () => handle.jobRunning() ?? undefined,
      terminate: () => handle.jobTerminate(),
      dispose: () => handle.jobDispose(),
    };
  }

  /** Releases the pipes; the leader stays held until its exit has been heard. */
  dispose(): void {
    try {
      this.handle?.dispose();
    } catch {
      /* Best effort during process exit. */
    }
  }
}

/**
 * A process group known by its leader's identity (pid and kernel start), as the native
 * supervisor answers for it: held (and signalled by number) only while that leader is unreaped
 * or verified alive; otherwise its recorded or verified members, one by one.
 */
export function nativeGroup(pid: number, start: string) {
  const native = addon();
  return {
    hold: () => native.supervisorHoldGroup(pid, start),
    unhold: () => native.supervisorUnholdGroup(pid, start),
    signalGroup: (signal: NodeJS.Signals) => {
      native.supervisorSignalGroup(pid, start, signal);
    },
    groupGone: () => native.supervisorGroupGone(pid, start),
    disown: () => {},
    leaderStart: () => start,
    // Held only if the registry knows it; otherwise a group by identity alone.
    spawned: false,
  };
}

let holdLimitHandler: ((child: NativeChildProcess) => void) | undefined;
/**
 * What a given-up group still occupied at the native hold limit gets: the owner's guarded kill
 * (`process-owner.ts` installs it), so kept processes and a stop's caller are spared, and a
 * group with spared members stays held.
 */
export function onHoldLimit(handler: (child: NativeChildProcess) => void): void {
  holdLimitHandler = handler;
}

/** Spawns a supervised child; byte events arrive in arrival order. */
export function nativeSpawnChild(spec: NativeSpawnSpec): NativeChildProcess {
  return new NativeChildProcess(spec);
}

/** The native child's own job: the one the shell's stop plan holds and disposes. */
export function nativeChildJob(
  child: unknown,
): import("./process-containment.ts").WindowsJob | undefined {
  return child instanceof NativeChildProcess ? child.job() : undefined;
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

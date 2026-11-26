// SPDX-License-Identifier: Apache-2.0

/**
 * The native core shell (G2): the JS half of the port bridge plus the
 * dispatch for the process layer (G2a), ordering and leases (G2b), and
 * policy and configuration (G2c).
 */
import { Buffer } from "node:buffer";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, type Writable } from "node:stream";
import {
  gitCrossSelected,
  type GitPart,
  type NativeBackend,
} from "@ace/provider-kit/native-switches";
import { runningChildren } from "./git-processes.ts";
import { forgetLease, owned } from "./lease-journal.ts";
import { ownedByThisProcess } from "./lease-owner.ts";
import { captureMutationOwnership, settleOwnLeases, type LeaseProbe } from "./mutation-leases.ts";
import {
  countGitFallback,
  gitAddon,
  type NativeGitCoreHandle,
  recordGitOp,
  reserveGitOpSeq,
  runNativeOp,
  runNativeOpSync,
  throwGitError,
} from "./native-common.ts";
import type { CleanupResult, MutationLease } from "@ace/provider-kit/cleanup";
import { GitError, type GitErrorCode, type GitOptions, type GitProcessRuntime } from "./types.ts";

const part = "core" satisfies GitPart;
const gitFailedPrefix = "git_failed:";

/**
 * stdin bytes handed to the core but not yet written: a `Readable` input is
 * paused above this and resumed once the core acknowledges below the low mark,
 * the backpressure Node's `pipe()` gives a destination.
 */
const stdinHighWater = 1024 * 1024;
const stdinLowWater = 256 * 1024;

/** The arguments a lease operation needs from `GitService` (its path, or its sweep). */
export interface NativeLeaseArgs {
  path?: string;
  paths?: readonly string[];
  failed?: (path: string, error: unknown) => void;
  /** The calling service's own core: its probe, clock and injected ports, never another's. */
  core?: NativeCoreCli | undefined;
}

/** The core operations served by the lease modules (`core::lease`). */
const leaseOps = new Set([
  "assertMutationAvailable",
  "mutationState",
  "clearStaleLeases",
  "heal",
  "healAll",
  "recoverCleanup",
]);

/**
 * The lease dispatcher for one operation, or `undefined` when it stays on the
 * probe. Each service dispatches through its own core: its lease probe, wait,
 * evidence and injected ports are its own (rule 4).
 */
function runLease<T>(
  op: string,
  args: NativeLeaseArgs | undefined,
  typescript: () => Promise<T>,
): Promise<T> | undefined {
  const core = args?.core;
  if (args === undefined || core === undefined || !leaseOps.has(op)) return undefined;
  return core.runLeaseOp(op, args, typescript as () => Promise<unknown>) as Promise<T>;
}

/** Dispatches one core operation to the native core when the part is on. */
export function runNativeCore<T>(
  op: string,
  typescript: () => Promise<T>,
  args?: NativeLeaseArgs,
): Promise<T> {
  return runLease(op, args, typescript) ?? runNativeOp(part, op, typescript);
}

/** The synchronous `runNativeCore`, for the calls that stay synchronous. */
export function runNativeCoreSync<T>(op: string, typescript: () => T, args?: NativeLeaseArgs): T {
  const core = args?.core;
  if (args !== undefined && core !== undefined && leaseOps.has(op)) {
    return core.runLeaseOp(op, args, typescript as () => Promise<unknown>) as T;
  }
  return runNativeOpSync(part, op, typescript);
}

/** The injected `GitProcessRuntime` members passed through for G0 bridge checks. */
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
  readonly pid: number | undefined;
  drain(): string[];
  writeStdin(data: Uint8Array): void;
  endStdin(): void;
  close(): void;
}

/** Wraps an injected `spawn`'s `ChildProcess` for G0 bridge tests. */
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

export interface NativeExecuteOutput {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  stopped?: "capture" | "budget";
}

export interface NativeExecuteParams {
  cwd: string;
  args: string[];
  binary: string;
  env: Record<string, string | undefined>;
  write: boolean;
  stripAskpass: boolean;
  executionDisabled: boolean;
  allowFailure: boolean;
  captureBytes?: number;
  timeoutMs?: number;
  stopAtCapture: boolean;
  stopAfterMs?: number;
  bounded: boolean;
  input?: string | Uint8Array | Readable;
  output?: Writable;
  consume?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  beforeSpawn?: () => void;
  signal?: AbortSignal;
  directoryFd?: number;
}

interface ParsedFailure {
  code: GitErrorCode;
  message: string;
  details: Record<string, unknown>;
  cleanupId?: number;
  cleanupGroupPid?: number;
}

interface StreamTarget {
  output?: Writable;
  consume?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
}

interface PortMessage {
  op: string;
  reqId?: number;
  spawnId?: number;
  timerId?: number;
  callId?: number;
  bytes?: number;
  record?: unknown;
  lease?: unknown;
  envJson?: string;
  value?: unknown;
  listing?: unknown[];
  event?: unknown;
  pid?: number;
  ms?: number;
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: [string, string][];
  detached?: boolean;
  signal?: NodeJS.Signals;
  leasesJson?: string;
}

function parseFailurePayload(error: unknown): ParsedFailure | undefined {
  if (!(error instanceof Error) || !error.message.startsWith(gitFailedPrefix)) return undefined;
  try {
    return JSON.parse(error.message.slice(gitFailedPrefix.length)) as ParsedFailure;
  } catch {
    return undefined;
  }
}

function serializeCallbackError(error: unknown): string {
  if (error instanceof GitError) {
    return JSON.stringify({ ok: false, code: error.code, message: error.message });
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      return JSON.stringify({ ok: false, errno: code, message: error.message });
    }
    return JSON.stringify({ ok: false, code: "git_failed", message: error.message });
  }
  return JSON.stringify({ ok: false, code: "git_failed", message: String(error) });
}

function writeChunkToWritable(output: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      output.off("error", onError);
      output.off("close", onClose);
      output.off("drain", onDrain);
    };
    output.once("error", onError);
    output.once("close", onClose);
    if (output.write(chunk)) {
      cleanup();
      resolve();
    } else {
      output.once("drain", onDrain);
    }
  });
}

/** Native process-layer runner owned by one `GitCli` when `ACE_GIT=core` is on (G2a). */
export class NativeCoreCli {
  private readonly handle: NativeGitCoreHandle;
  private readonly runtime: GitProcessRuntime;
  private readonly useJsCleanupSupervisor: boolean;
  private readonly children = new Map<number, ChildProcessWithoutNullStreams>();
  private readonly timers = new Map<number, () => void>();
  private readonly streams = new Map<number, StreamTarget>();
  private readonly killed: Set<string>;
  private readonly leaseProbe: LeaseProbe;
  /** The config query each `transportConfig` call uses, by call id. */
  private readonly transportCalls = new Map<
    number,
    (args: string[]) => Promise<{ stdout: Buffer; exitCode: number; truncated: boolean }>
  >();
  private nextTransportCall = 1;
  /** The answers each `configFactsRead` call's ports need, by call id. */
  private readonly configCalls = new Map<
    number,
    {
      sources: (cwd: string, env: [string, string][]) => Promise<string[] | undefined>;
      compute: () => Promise<unknown>;
      keep: (value: unknown) => boolean;
    }
  >();
  private nextConfigCall = 1;
  /**
   * Calls still in flight, and the killed calls' lease settlements they started.
   * `close` waits for both: a settlement removes the leftover locks a killed
   * Git call held, and must finish before close resolves.
   */
  private readonly operations = new Set<Promise<unknown>>();
  private readonly settlements = new Set<Promise<unknown>>();
  /** Unacknowledged stdin bytes per call, and the input paused by them. */
  private readonly stdinOutstanding = new Map<number, number>();
  private readonly stdinInputs = new Map<number, Readable>();

  constructor(
    options: GitOptions,
    runtime: GitProcessRuntime,
    killed: Set<string>,
    leaseProbe: LeaseProbe,
  ) {
    this.runtime = runtime;
    this.killed = killed;
    this.leaseProbe = leaseProbe;
    this.useJsCleanupSupervisor = options.processRuntime?.cleanupSupervisor !== undefined;
    const config = {
      binary: options.gitBinary,
      timeoutMs: options.timeoutMs,
      platform: runtime.platform,
      useJsSpawn: options.processRuntime?.spawn !== undefined || this.useJsCleanupSupervisor,
      useJsScheduler: options.processRuntime?.scheduleTimeout !== undefined,
      useJsSignalGroup: options.processRuntime?.signalGroup !== undefined,
      useJsGroupAlive: options.processRuntime?.groupAlive !== undefined,
      useJsCleanupSupervisor: this.useJsCleanupSupervisor,
      // A cleanup supervisor owns the proof that killed writers stopped: no evidence to weigh.
      leaseEvidence: !this.useJsCleanupSupervisor,
      leaseWaitMs: options.leaseWaitMs ?? 60_000,
    };
    const addon = gitAddon();
    try {
      this.handle = new addon.NativeGitCore(JSON.stringify(config), (eventJson, data) => {
        this.onPort(eventJson, data);
      });
    } catch (error) {
      throwGitError(error);
    }
  }

  /**
   * Reads one cached configuration fact (G2c). The cache, stamps and learning are
   * the core's; `sources`, `compute` and `keep` answer its ports on this thread.
   */
  configFactsRead(
    input: { cwd: string; name: string; env: [string, string][] },
    ports: {
      sources: (cwd: string, env: [string, string][]) => Promise<string[] | undefined>;
      compute: () => Promise<unknown>;
      keep: (value: unknown) => boolean;
    },
    typescript: () => Promise<unknown>,
  ): Promise<unknown> {
    const selected: NativeBackend = gitCrossSelected() ?? "native";
    const seq = reserveGitOpSeq();
    if (selected === "typescript") {
      recordGitOp({ seq, op: "configRead", part, selected, completed: "typescript" });
      return typescript();
    }
    const callId = this.nextConfigCall++;
    this.configCalls.set(callId, ports);
    return new Promise<unknown>((resolve, reject) => {
      const finish = (): void => {
        this.configCalls.delete(callId);
      };
      try {
        this.handle.configRead(
          JSON.stringify({ callId, cwd: input.cwd, name: input.name, env: input.env }),
          (error: unknown, json?: string) => {
            recordGitOp({ seq, op: "configRead", part, selected, completed: "native" });
            finish();
            if (error !== null && error !== undefined) {
              try {
                throwGitError(error);
              } catch (mapped) {
                reject(mapped);
              }
              return;
            }
            resolve(JSON.parse(json ?? "null"));
          },
        );
      } catch (error) {
        recordGitOp({ seq, op: "configRead", part, selected, completed: "native" });
        finish();
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
      }
    });
  }

  /**
   * The files whose change can alter a checkout's configuration (G2c): parsed,
   * listed and walked by the core from the raw Git output. `typescript`
   * answers the cross gate's off leg unchanged.
   */
  configWatch(
    input: {
      cwd: string;
      gitDir: string | undefined;
      commonDir: string | undefined;
      toplevel: string | undefined;
      listing: string | undefined;
      standard: readonly string[];
      home: string | undefined;
      isWindows: boolean;
    },
    typescript: () => Promise<string[] | undefined> | string[] | undefined,
  ): Promise<string[] | undefined> {
    const selected: NativeBackend = gitCrossSelected() ?? "native";
    const seq = reserveGitOpSeq();
    if (selected === "typescript") {
      recordGitOp({ seq, op: "configWatch", part, selected, completed: "typescript" });
      return Promise.resolve(typescript());
    }
    return new Promise((resolve, reject) => {
      try {
        this.handle.configWatch(
          JSON.stringify({
            cwd: input.cwd,
            gitDir: input.gitDir ?? null,
            commonDir: input.commonDir ?? null,
            toplevel: input.toplevel ?? null,
            listing: input.listing ?? null,
            standard: [...input.standard],
            home: input.home ?? null,
            isWindows: input.isWindows,
          }),
          (error: unknown, json?: string) => {
            recordGitOp({ seq, op: "configWatch", part, selected, completed: "native" });
            if (error !== null && error !== undefined) {
              try {
                throwGitError(error);
              } catch (mapped) {
                reject(mapped);
              }
              return;
            }
            const value = JSON.parse(json ?? "{}") as { paths: string[] | null };
            resolve(value.paths ?? undefined);
          },
        );
      } catch (error) {
        recordGitOp({ seq, op: "configWatch", part, selected, completed: "native" });
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
      }
    });
  }

  /**
   * The execution policy for one Git call (G2c): the guarded or hookless
   * environment and the arguments that precede the command. `typescript`
   * answers the cross gate's off leg unchanged.
   */
  preparePolicy(
    input: {
      keys?: string;
      guarded?: boolean;
      hookless?: boolean;
      transport?: { protocols: readonly string[]; sshCommand?: string | undefined } | null;
    },
    typescript: () => { env: Record<string, string>; args: string[] },
  ): Promise<{ env: Record<string, string>; args: string[] }> {
    const selected: NativeBackend = gitCrossSelected() ?? "native";
    const seq = reserveGitOpSeq();
    if (selected === "typescript") {
      recordGitOp({ seq, op: "preparePolicy", part, selected, completed: "typescript" });
      return Promise.resolve(typescript());
    }
    return new Promise((resolve, reject) => {
      try {
        this.handle.prepareCall(
          JSON.stringify({
            keys: input.keys ?? "",
            guarded: input.guarded === true,
            hookless: input.hookless === true,
            transport:
              input.transport === null || input.transport === undefined
                ? null
                : {
                    protocols: [...input.transport.protocols],
                    sshCommand: input.transport.sshCommand,
                  },
          }),
          (error: unknown, json?: string) => {
            recordGitOp({ seq, op: "preparePolicy", part, selected, completed: "native" });
            if (error !== null && error !== undefined) {
              try {
                throwGitError(error);
              } catch (mapped) {
                reject(mapped);
              }
              return;
            }
            const value = JSON.parse(json ?? "{}") as {
              env: [string, string][];
              args: string[];
            };
            resolve({ env: Object.fromEntries(value.env), args: value.args });
          },
        );
      } catch (error) {
        recordGitOp({ seq, op: "preparePolicy", part, selected, completed: "native" });
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
      }
    });
  }

  /** Runs one lease operation in the core and maps its answer back to `GitService`'s shape. */
  runLeaseOp(
    op: string,
    args: NativeLeaseArgs,
    typescript: () => Promise<unknown>,
  ): Promise<unknown> {
    const selected: NativeBackend = gitCrossSelected() ?? "native";
    const seq = reserveGitOpSeq();
    if (selected === "typescript") {
      recordGitOp({ seq, op, part, selected, completed: "typescript" });
      return typescript();
    }
    return new Promise<unknown>((resolve, reject) => {
      try {
        this.handle.leaseOp(
          op,
          JSON.stringify({ path: args.path, paths: args.paths }),
          (error: unknown, json?: string) => {
            recordGitOp({ seq, op, part, selected, completed: "native" });
            if (error !== null && error !== undefined) {
              try {
                throwGitError(error);
              } catch (mapped) {
                reject(mapped);
              }
              return;
            }
            const value = JSON.parse(json ?? "null") as Record<string, unknown>;
            if (op === "healAll" && Array.isArray(value.failed)) {
              for (const failure of value.failed as {
                path: string;
                code: GitErrorCode;
                message: string;
                details: Record<string, unknown>;
              }[])
                args.failed?.(
                  failure.path,
                  new GitError(failure.code, failure.message, failure.details),
                );
            }
            if (op === "assertMutationAvailable") {
              resolve(undefined);
              return;
            }
            resolve(op === "heal" || op === "healAll" ? value.removed : value);
          },
        );
      } catch (error) {
        recordGitOp({ seq, op, part, selected, completed: "native" });
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
      }
    });
  }

  /**
   * The person's own credential helpers and SSH command for a transfer (G2c). The
   * core decides which files count and which entries are trusted; `query` runs Git.
   */
  transportConfig(
    input: {
      system: string | undefined;
      files: readonly (string | undefined)[];
      protectedRoots: readonly string[];
      helpers: boolean;
      repositorySsh: boolean;
    },
    query: (args: string[]) => Promise<{ stdout: Buffer; exitCode: number; truncated: boolean }>,
    typescript: () => Promise<{
      helpers: { key: string; value: string }[];
      sshCommand: string | undefined;
    }>,
  ): Promise<{ helpers: { key: string; value: string }[]; sshCommand: string | undefined }> {
    const selected: NativeBackend = gitCrossSelected() ?? "native";
    const seq = reserveGitOpSeq();
    if (selected === "typescript") {
      recordGitOp({ seq, op: "transportConfig", part, selected, completed: "typescript" });
      return typescript();
    }
    const callId = this.nextTransportCall++;
    this.transportCalls.set(callId, query);
    return new Promise((resolve, reject) => {
      try {
        this.handle.transportConfig(
          JSON.stringify({
            callId,
            system: input.system ?? null,
            files: input.files.map((file) => file ?? null),
            protectedRoots: [...input.protectedRoots],
            helpers: input.helpers,
            repositorySsh: input.repositorySsh,
          }),
          (error: unknown, json?: string) => {
            recordGitOp({ seq, op: "transportConfig", part, selected, completed: "native" });
            this.transportCalls.delete(callId);
            if (error !== null && error !== undefined) {
              try {
                throwGitError(error);
              } catch (mapped) {
                reject(mapped);
              }
              return;
            }
            const value = JSON.parse(json ?? "{}") as {
              helpers: { key: string; value: string }[];
              sshCommand: string | null;
            };
            resolve({ helpers: value.helpers, sshCommand: value.sshCommand ?? undefined });
          },
        );
      } catch (error) {
        recordGitOp({ seq, op: "transportConfig", part, selected, completed: "native" });
        this.transportCalls.delete(callId);
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
      }
    });
  }

  /** `git version M.m` through the core's schemas (G2c). */
  decodeVersion(text: string): [number, number] | undefined {
    const parsed = JSON.parse(gitAddon().gitDecodeVersion(text)) as {
      major: number;
      minor: number;
    } | null;
    return parsed === null ? undefined : [parsed.major, parsed.minor];
  }

  jobAlive(pid: number): boolean {
    return this.handle.jobAlive(pid);
  }

  pause(milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.handle.pause(milliseconds, (error) => {
        if (error !== null && error !== undefined) {
          try {
            throwGitError(error);
          } catch (mapped) {
            reject(mapped);
          }
          return;
        }
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.handle.close(() => {
        for (const cancel of this.timers.values()) cancel();
        this.timers.clear();
        // The native core stops the killed calls before it answers, but their
        // failure settlements (and the lease retirements that delete the
        // leftover locks) run afterwards on this thread.
        void this.settleOperations().then(resolve);
      });
    });
  }

  /** Waits until every in-flight call and every settlement it started has finished. */
  private async settleOperations(): Promise<void> {
    while (this.operations.size > 0 || this.settlements.size > 0) {
      await Promise.allSettled([...this.operations, ...this.settlements]);
    }
  }

  private awaitNativeCleanup(cleanupId: number): Promise<CleanupResult> {
    return new Promise((resolve) => {
      this.handle.awaitCleanup(cleanupId, (error, json) => {
        if ((error !== null && error !== undefined) || json === undefined) {
          resolve({ status: "unconfirmed", reason: "Cleanup settlement failed" });
          return;
        }
        try {
          const parsed = JSON.parse(json) as { result: CleanupResult };
          resolve(parsed.result);
        } catch {
          resolve({ status: "unconfirmed", reason: "Malformed cleanup receipt" });
        }
      });
    });
  }

  private quarantineSync(
    ownership: ReturnType<typeof captureMutationOwnership>,
    cleanupId: number,
    groupPid: number | undefined,
  ): Promise<CleanupResult> {
    const settled = this.awaitNativeCleanup(cleanupId);
    const cleanup = ownership.quarantine({ settled }, groupPid);
    if (groupPid !== undefined && ownership.leases.length > 0) {
      const ids = ownership.leases.map(({ id }) => id);
      for (const id of ids) this.killed.add(id);
      const settlement = settleOwnLeases(ids, this.leaseProbe).then(
        () => ids.forEach((id) => this.killed.delete(id)),
        () => {},
      );
      this.settlements.add(settlement);
      void settlement.then(
        () => this.settlements.delete(settlement),
        () => this.settlements.delete(settlement),
      );
    }
    return cleanup;
  }

  executeRaw(
    params: NativeExecuteParams,
    typescript: () => Promise<NativeExecuteOutput>,
  ): Promise<NativeExecuteOutput> {
    const selected: NativeBackend = gitCrossSelected() ?? "native";
    const seq = reserveGitOpSeq();
    if (selected === "typescript") {
      recordGitOp({ seq, op: "executeRaw", part, selected, completed: "typescript" });
      return typescript();
    }
    if (params.directoryFd !== undefined && this.runtime.platform !== "win32") {
      recordGitOp({
        seq,
        op: "executeRaw",
        part,
        selected,
        completed: "typescript",
        fallback: "directory_fd",
      });
      countGitFallback("directory_fd");
      return typescript();
    }

    try {
      params.beforeSpawn?.();
    } catch (error) {
      recordGitOp({ seq, op: "executeRaw", part, selected, completed: "native" });
      return Promise.reject(error);
    }
    if (params.signal?.aborted) {
      recordGitOp({ seq, op: "executeRaw", part, selected, completed: "native" });
      return Promise.reject(
        new GitError("git_cancelled", "Git operation cancelled before dispatch"),
      );
    }

    const ownership = captureMutationOwnership();
    const rawInput = params.input;
    const isReadable = rawInput instanceof Readable;
    let staticInput: Uint8Array | null = null;
    if (rawInput !== undefined && !(rawInput instanceof Readable)) {
      staticInput =
        typeof rawInput === "string"
          ? Buffer.from(rawInput, "utf8")
          : Buffer.from(rawInput.buffer, rawInput.byteOffset, rawInput.byteLength);
    }

    const envPairs: [string, string][] = [];
    for (const [k, v] of Object.entries(params.env)) {
      if (v !== undefined) envPairs.push([k, v]);
    }

    const req = {
      cwd: params.cwd,
      args: params.args,
      binary: params.binary,
      env: envPairs,
      write: params.write,
      stripAskpass: params.stripAskpass,
      executionDisabled: params.executionDisabled,
      allowFailure: params.allowFailure,
      captureBytes: params.captureBytes,
      timeoutMs: params.timeoutMs,
      stopAtCapture: params.stopAtCapture,
      stopAfterMs: params.stopAfterMs,
      bounded: params.bounded,
      hasInput: params.input !== undefined,
      streamStdin: isReadable,
      streamStdout: params.output !== undefined || params.consume !== undefined,
      streamStderr: params.stderr !== undefined,
      leasesJson: JSON.stringify(ownership.leases),
      abortedBeforeDispatch: params.signal?.aborted === true,
    };

    const operation = new Promise<NativeExecuteOutput>((resolve, reject) => {
      let callId = 0;
      let settled = false;
      // TS pipes stdout into `output`: the pipe ends it at EOF whether Git
      // succeeded, failed or was stopped, and exactly once.
      let outputEnded = false;
      const endOutput = () => {
        if (params.output === undefined || outputEnded) return;
        outputEnded = true;
        params.output.end();
      };
      const cleanupListeners = () => {
        if (onAbort) params.signal?.removeEventListener("abort", onAbort);
        if (onOutputError) params.output?.off("error", onOutputError);
        if (readable) {
          if (onData) readable.off("data", onData);
          if (onEnd) readable.off("end", onEnd);
          if (onReadableError) readable.off("error", onReadableError);
        }
        if (callId !== 0) {
          this.streams.delete(callId);
          this.stdinOutstanding.delete(callId);
          const paused = this.stdinInputs.get(callId);
          this.stdinInputs.delete(callId);
          if (paused && paused.isPaused()) paused.resume();
        }
      };

      const onAbort = params.signal
        ? () => {
            if (!settled && callId !== 0) this.handle.abortCall(callId);
          }
        : undefined;

      const onOutputError = params.output
        ? (err: NodeJS.ErrnoException) => {
            if (!settled && callId !== 0) {
              this.handle.failStdin(callId, null, err.code ?? null, err.message);
            }
          }
        : undefined;

      const readable = isReadable ? (params.input as Readable) : undefined;
      const onData = readable
        ? (chunk: Buffer | string) => {
            if (settled || callId === 0) return;
            const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            const outstanding = (this.stdinOutstanding.get(callId) ?? 0) + buf.byteLength;
            this.stdinOutstanding.set(callId, outstanding);
            if (outstanding > stdinHighWater && !readable.isPaused()) {
              this.stdinInputs.set(callId, readable);
              readable.pause();
            }
            this.handle.writeStdin(callId, buf);
          }
        : undefined;
      const onEnd = readable
        ? () => {
            if (!settled && callId !== 0) this.handle.endStdin(callId);
          }
        : undefined;
      const onReadableError = readable
        ? (err: NodeJS.ErrnoException) => {
            if (!settled && callId !== 0) {
              this.handle.failStdin(callId, null, err.code ?? null, err.message);
            }
          }
        : undefined;

      try {
        callId = this.handle.executeRaw(
          JSON.stringify(req),
          staticInput,
          (error, metaJson, out) => {
            settled = true;
            cleanupListeners();
            recordGitOp({ seq, op: "executeRaw", part, selected, completed: "native" });
            if (error !== null && error !== undefined) {
              const payload = parseFailurePayload(error);
              if (payload !== undefined) {
                const gitErr = new GitError(payload.code, payload.message, payload.details);
                if (payload.cleanupId !== undefined) {
                  const cleanup = this.quarantineSync(
                    ownership,
                    payload.cleanupId,
                    payload.cleanupGroupPid,
                  );
                  gitErr.cleanup = { settled: cleanup };
                }
                endOutput();
                reject(gitErr);
                return;
              }
              endOutput();
              try {
                throwGitError(error);
              } catch (mapped) {
                reject(mapped);
              }
              return;
            }
            const meta = JSON.parse(metaJson ?? "{}") as {
              stderr: string;
              exitCode: number;
              truncated: boolean;
              stopped?: "capture" | "budget";
              cleanupId?: number;
              cleanupGroupPid?: number;
            };
            if (meta.cleanupId !== undefined) {
              void this.quarantineSync(ownership, meta.cleanupId, meta.cleanupGroupPid);
            }
            endOutput();
            const stdoutBuf = out
              ? Buffer.from(out.buffer, out.byteOffset, out.byteLength)
              : Buffer.alloc(0);
            resolve({
              stdout: stdoutBuf,
              stderr: meta.stderr,
              exitCode: meta.exitCode,
              truncated: meta.truncated,
              ...(meta.stopped === undefined ? {} : { stopped: meta.stopped }),
            });
          },
        );
      } catch (error) {
        settled = true;
        cleanupListeners();
        endOutput();
        recordGitOp({ seq, op: "executeRaw", part, selected, completed: "native" });
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
        return;
      }

      if (params.output || params.consume || params.stderr) {
        this.streams.set(callId, {
          ...(params.output ? { output: params.output } : {}),
          ...(params.consume ? { consume: params.consume } : {}),
          ...(params.stderr ? { stderr: params.stderr } : {}),
        });
      }
      if (onAbort) params.signal?.addEventListener("abort", onAbort, { once: true });
      if (onOutputError) params.output?.on("error", onOutputError);
      if (readable && onData && onEnd && onReadableError) {
        readable.on("data", onData);
        readable.once("end", onEnd);
        readable.once("error", onReadableError);
      }
      if (params.signal?.aborted) this.handle.abortCall(callId);
    });
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private onPort(eventJson: string, data: Uint8Array): void {
    const msg = JSON.parse(eventJson) as PortMessage;
    switch (msg.op) {
      case "transport_query": {
        const reqId = msg.reqId ?? 0;
        const query = this.transportCalls.get(msg.callId ?? 0);
        if (query === undefined) {
          this.handle.replyPort(
            reqId,
            JSON.stringify({ stdout: "", exitCode: 1, truncated: false }),
          );
          return;
        }
        void query((msg.args ?? []) as string[]).then(
          (output) =>
            this.handle.replyPort(
              reqId,
              JSON.stringify({
                stdout: output.stdout.toString("latin1"),
                exitCode: output.exitCode,
                truncated: output.truncated,
              }),
            ),
          () =>
            this.handle.replyPort(
              reqId,
              JSON.stringify({ stdout: "", exitCode: 1, truncated: false }),
            ),
        );
        return;
      }
      case "config_sources": {
        const reqId = msg.reqId ?? 0;
        const ports = this.configCalls.get(msg.callId ?? 0);
        if (ports === undefined) {
          this.handle.replyPort(reqId, JSON.stringify({ paths: null }));
          return;
        }
        void ports
          .sources(msg.cwd ?? "", JSON.parse(msg.envJson ?? "[]") as [string, string][])
          .then((paths) => this.handle.replyPort(reqId, JSON.stringify({ paths: paths ?? null })))
          .catch(() => this.handle.replyPort(reqId, JSON.stringify({ paths: null })));
        return;
      }
      case "config_compute": {
        const reqId = msg.reqId ?? 0;
        const ports = this.configCalls.get(msg.callId ?? 0);
        if (ports === undefined) {
          this.handle.replyPort(reqId, JSON.stringify({ error: { code: "git_closed" } }));
          return;
        }
        void ports.compute().then(
          (value) =>
            this.handle.replyPort(
              reqId,
              JSON.stringify({ value: JSON.parse(JSON.stringify(value ?? null)) }),
            ),
          (error: unknown) => {
            const gitError = error instanceof GitError ? error : undefined;
            this.handle.replyPort(
              reqId,
              JSON.stringify({
                error: {
                  code: gitError?.code ?? "git_failed",
                  message: gitError?.message ?? String(error),
                  details: gitError?.details ?? {},
                },
              }),
            );
          },
        );
        return;
      }
      case "config_keep": {
        const reqId = msg.reqId ?? 0;
        const ports = this.configCalls.get(msg.callId ?? 0);
        const keep = ports?.keep(msg.value) ?? true;
        this.handle.replyPort(reqId, JSON.stringify({ keep }));
        return;
      }
      case "config_now": {
        const reqId = msg.reqId ?? 0;
        this.handle.replyPort(reqId, JSON.stringify({ ms: this.runtime.fileClock() }));
        return;
      }
      case "lease_local": {
        const reqId = msg.reqId ?? 0;
        const record = (msg.record as MutationLease | undefined) ?? null;
        const local = record === null ? undefined : owned(record.id);
        this.handle.replyPort(
          reqId,
          JSON.stringify({
            present: local !== undefined,
            live: local !== undefined && !local.done,
            quarantined: local?.quarantined === true,
            done: local?.done === true,
            ...(local?.groups === undefined ? {} : { groups: local.groups }),
            mine: record === null ? false : ownedByThisProcess(record),
            ...(local === undefined ? {} : { recordJson: JSON.stringify(local.record) }),
          }),
        );
        return;
      }
      case "lease_processes": {
        const reqId = msg.reqId ?? 0;
        void this.runtime
          .gitProcesses()
          .then((listing) =>
            this.handle.replyPort(
              reqId,
              JSON.stringify({ listing: listing === undefined ? null : listing }),
            ),
          )
          .catch(() => this.handle.replyPort(reqId, JSON.stringify({ listing: null })));
        return;
      }
      case "lease_group_alive": {
        const reqId = msg.reqId ?? 0;
        void Promise.resolve(this.runtime.groupAlive(msg.pid ?? 0))
          .then((alive: boolean) => this.handle.replyPort(reqId, JSON.stringify({ alive })))
          .catch(() => this.handle.replyPort(reqId, JSON.stringify({ alive: true })));
        return;
      }
      case "lease_now": {
        const reqId = msg.reqId ?? 0;
        void Promise.resolve(this.leaseProbe.evidence?.now?.() ?? new Date())
          .then((now: Date) => this.handle.replyPort(reqId, JSON.stringify({ ms: now.getTime() })))
          .catch(() => this.handle.replyPort(reqId, JSON.stringify({ ms: Date.now() })));
        return;
      }
      case "lease_running_when_gone": {
        const reqId = msg.reqId ?? 0;
        const lease = (msg.lease as MutationLease | undefined) ?? null;
        const listing = (msg.listing ?? []) as { pid: number }[];
        const earlier =
          lease === null
            ? undefined
            : this.leaseProbe.evidence?.runningWhenGone?.(
                lease,
                listing as Parameters<
                  NonNullable<NonNullable<LeaseProbe["evidence"]>["runningWhenGone"]>
                >[1],
              );
        this.handle.replyPort(
          reqId,
          JSON.stringify({
            pids:
              earlier === undefined
                ? null
                : (listing as Parameters<typeof earlier>[0][])
                    .filter(earlier)
                    .map((entry) => entry.pid),
          }),
        );
        return;
      }
      case "lease_recover": {
        const reqId = msg.reqId ?? 0;
        const lease = (msg.lease as MutationLease | undefined) ?? null;
        const supervisor = this.runtime.cleanupSupervisor;
        if (lease === null || supervisor === undefined) {
          this.handle.replyPort(
            reqId,
            JSON.stringify({
              status: "unconfirmed",
              reason: "No escaped-descendant containment supervisor",
            }),
          );
          return;
        }
        void supervisor.recover(lease).then(
          (outcome) => this.handle.replyPort(reqId, JSON.stringify(outcome)),
          () =>
            this.handle.replyPort(
              reqId,
              JSON.stringify({ status: "unconfirmed", reason: "Cleanup supervisor failed" }),
            ),
        );
        return;
      }
      case "lease_retired": {
        const event = msg.event as Parameters<NonNullable<LeaseProbe["retired"]>>[0];
        // The core removed the intent: this process must not hold or retire it again.
        forgetLease(event.lease.id);
        this.leaseProbe.retired?.(event);
        return;
      }
      case "stdin_ack": {
        const id = msg.callId ?? 0;
        const outstanding = Math.max(0, (this.stdinOutstanding.get(id) ?? 0) - (msg.bytes ?? 0));
        this.stdinOutstanding.set(id, outstanding);
        const paused = this.stdinInputs.get(id);
        if (paused && outstanding <= stdinLowWater) {
          this.stdinInputs.delete(id);
          if (paused.isPaused()) paused.resume();
        }
        return;
      }
      case "pid_add":
        if (msg.pid !== undefined) runningChildren.add(msg.pid);
        return;
      case "pid_remove":
        if (msg.pid !== undefined) runningChildren.delete(msg.pid);
        return;
      case "schedule": {
        const id = msg.timerId ?? 0;
        const cancel = this.runtime.scheduleTimeout(() => {
          this.timers.delete(id);
          this.handle.fireTimer(id);
        }, msg.ms ?? 0);
        this.timers.set(id, cancel);
        return;
      }
      case "cancel_timer": {
        const id = msg.timerId ?? 0;
        const cancel = this.timers.get(id);
        if (cancel) {
          this.timers.delete(id);
          cancel();
        }
        return;
      }
      case "spawn":
        this.handleSpawn(msg);
        return;
      case "stdin_write": {
        const child = this.children.get(msg.spawnId ?? 0);
        if (child && data.byteLength > 0) {
          child.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        }
        return;
      }
      case "stdin_end":
        this.children.get(msg.spawnId ?? 0)?.stdin.end();
        return;
      case "kill_leader":
        this.children.get(msg.spawnId ?? 0)?.kill(msg.signal ?? "SIGKILL");
        return;
      case "destroy": {
        const id = msg.spawnId ?? 0;
        const child = this.children.get(id);
        if (child) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
        return;
      }
      case "release_child": {
        this.children.delete(msg.spawnId ?? 0);
        return;
      }
      case "signal_group": {
        const reqId = msg.reqId ?? 0;
        const child = msg.spawnId !== undefined ? this.children.get(msg.spawnId) : undefined;
        try {
          this.runtime.signalGroup(msg.pid ?? 0, msg.signal ?? "SIGKILL", child);
          this.handle.replyPort(reqId, JSON.stringify({ ok: true }));
        } catch (error) {
          this.handle.replyPort(
            reqId,
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }
      case "group_alive": {
        const reqId = msg.reqId ?? 0;
        const child = msg.spawnId !== undefined ? this.children.get(msg.spawnId) : undefined;
        const alive = this.runtime.groupAlive(msg.pid ?? 0, child);
        this.handle.replyPort(reqId, JSON.stringify({ alive }));
        return;
      }
      case "locate_git": {
        const reqId = msg.reqId ?? 0;
        const env = Object.fromEntries(msg.env ?? []);
        void this.runtime.locateGit(env, new AbortController().signal).then(
          (path) => this.handle.replyPort(reqId, JSON.stringify({ path: path ?? null })),
          () => this.handle.replyPort(reqId, JSON.stringify({ path: null })),
        );
        return;
      }
      case "cleanup_stop": {
        const reqId = msg.reqId ?? 0;
        const spawnId = msg.spawnId ?? 0;
        const child = this.children.get(spawnId);
        const sup = this.runtime.cleanupSupervisor;
        if (!child || !sup) {
          this.handle.replyPort(
            reqId,
            JSON.stringify({ error: "missing cleanup supervisor or child" }),
          );
          return;
        }
        let leases: MutationLease[] = [];
        try {
          leases = JSON.parse(msg.leasesJson ?? "[]") as MutationLease[];
        } catch {
          leases = [];
        }
        try {
          const receipt = sup.stop(child, leases);
          void receipt.settled.then(
            (result) => {
              this.handle.replyPort(reqId, JSON.stringify(result));
            },
            (error) => {
              this.handle.replyPort(
                reqId,
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            },
          );
        } catch (error) {
          this.handle.replyPort(
            reqId,
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
        return;
      }
      case "stream_stdout":
      case "stream_stderr":
        void this.handleStream(msg, data);
        return;
    }
  }

  private handleSpawn(msg: PortMessage): void {
    const reqId = msg.reqId ?? 0;
    const spawnId = msg.spawnId ?? 0;
    try {
      const child = this.runtime.spawn(msg.command ?? "git", msg.args ?? [], {
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
        env: Object.fromEntries(msg.env ?? []),
        shell: false,
        detached: msg.detached ?? false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.set(spawnId, child);
      child.stdout.on("data", (chunk: Buffer) => {
        this.handle.pushSpawnEvent(spawnId, "stdout", "{}", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.handle.pushSpawnEvent(spawnId, "stderr", "{}", chunk);
      });
      child.stdout.on("error", (err: NodeJS.ErrnoException) => {
        this.handle.pushSpawnEvent(
          spawnId,
          "stdout_error",
          JSON.stringify({ code: err.code ?? null, message: err.message }),
        );
      });
      child.stderr.on("error", (err: NodeJS.ErrnoException) => {
        this.handle.pushSpawnEvent(
          spawnId,
          "stderr_error",
          JSON.stringify({ code: err.code ?? null, message: err.message }),
        );
      });
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        this.handle.pushSpawnEvent(
          spawnId,
          "stdin_error",
          JSON.stringify({ code: err.code ?? null, message: err.message }),
        );
      });
      child.stdin.once("finish", () => {
        this.handle.pushSpawnEvent(spawnId, "stdin_finish", "{}");
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        this.handle.pushSpawnEvent(
          spawnId,
          "spawn_error",
          JSON.stringify({ code: err.code ?? null, message: err.message }),
        );
      });
      child.once("exit", (code, signal) => {
        this.handle.pushSpawnEvent(
          spawnId,
          "exit",
          JSON.stringify({ code, signal, pid: child.pid ?? null }),
        );
      });
      child.once("close", (code, signal) => {
        this.handle.pushSpawnEvent(spawnId, "close", JSON.stringify({ code, signal }));
      });
      this.handle.replyPort(reqId, JSON.stringify({ pid: child.pid ?? null }));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      this.handle.replyPort(
        reqId,
        JSON.stringify({
          pid: null,
          error: err instanceof Error ? err.message : String(error),
          code: err?.code ?? null,
        }),
      );
    }
  }

  private async handleStream(msg: PortMessage, data: Uint8Array): Promise<void> {
    const reqId = msg.reqId ?? 0;
    const target = this.streams.get(msg.callId ?? 0);
    if (!target) {
      this.handle.replyPort(reqId, JSON.stringify({ ok: true }));
      return;
    }
    const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      if (msg.op === "stream_stdout") {
        if (target.output) {
          await writeChunkToWritable(target.output, chunk);
        } else if (target.consume) {
          target.consume(chunk);
        }
      } else if (target.stderr) {
        target.stderr(chunk);
      }
      this.handle.replyPort(reqId, JSON.stringify({ ok: true }));
    } catch (error) {
      this.handle.replyPort(reqId, serializeCallbackError(error));
    }
  }
}

// SPDX-License-Identifier: Apache-2.0

/**
 * The shared native-git foundations (G0): the addon loader, the `git_failed`
 * mapping back to `GitError`, the per-operation record, the digest log and
 * the verify mode. The part shells (`native-refs`, `native-core`,
 * `native-reads`, `native-writes`, `native-checkpoints`) dispatch through
 * here; no work item but G0 edits this file.
 *
 * G0 behaviour: every native-selected operation probes the addon, which
 * throws the stub deferral, so the shell runs the TypeScript path and counts
 * the fallback. No behaviour change: with no part on, nothing here runs.
 */
import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  gitCrossSelected,
  type GitPart,
  type NativeBackend,
} from "@ace/provider-kit/native-switches";
import { GitError, type GitErrorCode } from "./types.ts";

/** One dispatched operation: the backend selected, the backend that ran it, and why not. */
export interface GitOpRecord {
  /** The call index in this process, so the cross gate can order selections. */
  seq: number;
  op: string;
  part: GitPart;
  selected: NativeBackend;
  completed: NativeBackend;
  /** Why the TypeScript path completed a native-selected operation. */
  fallback?: string | undefined;
  pid: number;
}

/** One write the digest log compares across backends. */
export interface GitDigestEntry {
  op: string;
  /** The write index in this process. */
  order: number;
  /** Result-derived identity only (ids, trees, shas): never extra Git work. */
  summary: string;
}

/** A ref read's answer: the bytes Git would print, or its `ace-json` text. */
export type NativeReply = Uint8Array | string;

/**
 * The addon callback that settles one ref read, on the JavaScript thread: `error` is the
 * addon's `git_failed` error and `reply` its answer.
 */
export type NativeSettle = (error: unknown, reply?: NativeReply) => void;

export type NativePortHandler = (eventJson: string, data: Uint8Array) => void;
export type NativeCoreRawSettle = (error: unknown, metaJson?: string, stdout?: Uint8Array) => void;
export type NativeJsonSettle = (error: unknown, json?: string) => void;

export interface NativeGitCoreHandle {
  executeRaw(reqJson: string, input: Uint8Array | null, settle: NativeCoreRawSettle): number;
  writeStdin(callId: number, chunk: Uint8Array): void;
  endStdin(callId: number): void;
  failStdin(callId: number, code: string | null, errno: string | null, message: string): void;
  abortCall(callId: number): void;
  awaitCleanup(cleanupId: number, settle: NativeJsonSettle): void;
  pause(milliseconds: number, settle: NativeJsonSettle): void;
  close(settle: NativeJsonSettle): void;
  activeCalls(): number;
  runningChildren(): number[];
  jobAlive(pid: number): boolean;
  setResolvedBinary(binary: string | null): void;
  replyPort(reqId: number, replyJson: string): void;
  pushSpawnEvent(
    spawnId: number,
    kind: string,
    payloadJson: string,
    chunk?: Uint8Array | null,
  ): void;
  fireTimer(timerId: number): void;
}

interface GitAddon {
  gitRefsAbortToken(): number;
  gitRefsAbort(token: number): void;
  gitRefsWorktrees(token: number, root: string, settle: NativeSettle): void;
  gitRefsBranchListing(
    token: number,
    root: string,
    patterns: string[],
    count: number,
    settle: NativeSettle,
  ): void;
  gitRefsBranchNames(
    token: number,
    root: string,
    patterns: string[],
    count: number,
    settle: NativeSettle,
  ): void;
  gitRefsCommit(token: number, root: string, reference: string, settle: NativeSettle): void;
  gitRefsBranchHead(token: number, root: string, reference: string, settle: NativeSettle): void;
  gitCoreProbe(op: string): string;
  gitValidateTimeout(ms?: number | null): number;
  gitVerifyVersion(stdout: Uint8Array, binary: string): void;
  NativeGitCore: new (configJson: string, onPort: NativePortHandler) => NativeGitCoreHandle;
  gitReadsProbe(op: string): string;
  gitWritesProbe(op: string): string;
  gitCheckpointsProbe(op: string): string;
  gitBridgeVersion(): string;
  GitPortBridge: new () => GitPortBridgeHandle;
}

export interface GitPortBridgeHandle {
  pushEvent(eventJson: string): number;
  drain(): string[];
  close(): void;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_GIT_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_GIT_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: GitAddon | undefined;
/** The git addon, failing at startup when a part is on and it is missing. */
export function gitAddon(): GitAddon {
  if (loaded) return loaded;
  const path = addonPath();
  // Never fall back for a missing addon: a run with the switch on must prove the native path.
  if (!existsSync(path))
    throw new Error(
      `ACE_GIT needs the git addon at ${path}; build it with cargo build --release -p ace-daemon-node in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting what `ace-daemon-node/src/git` declares.
  loaded = module.exports as unknown as GitAddon;
  if (loaded.gitBridgeVersion() !== "g0")
    throw new Error(`ACE_GIT addon speaks an unknown bridge version`);
  return loaded;
}

/** Fail at startup when any part is on and the addon is missing. */
export function ensureGitAddon(parts: ReadonlySet<GitPart>): void {
  if (parts.size > 0) void gitAddon();
}

const prefix = "git_failed:";

interface GitFailurePayload {
  code: GitErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/** The addon's `git_failed:{...}` error as the `GitError` it names. */
function parseGitFailure(error: Error): GitFailurePayload | undefined {
  if (!error.message.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(error.message.slice(prefix.length)) as GitFailurePayload;
  } catch {
    return undefined;
  }
}

/** Rethrows the addon's failure as its `GitError`, so `instanceof` holds. */
export function throwGitError(error: unknown): never {
  if (error instanceof GitError) throw error;
  if (error instanceof Error) {
    const payload = parseGitFailure(error);
    if (payload !== undefined) throw new GitError(payload.code, payload.message, payload.details);
  }
  throw error;
}

/** The G0 stub deferral's reason, or undefined for a real native failure. */
function stubDeferral(error: unknown): { part: string; op: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const payload = parseGitFailure(error);
  const details = payload?.details as { stub?: unknown; part?: unknown; op?: unknown } | undefined;
  if (payload?.code !== "git_failed" || details?.stub !== true) return undefined;
  if (typeof details.part !== "string" || typeof details.op !== "string") return undefined;
  return { part: details.part, op: details.op };
}

/** Appends one JSON line to `path`, if set; logs never break git. */
function appendLine(path: string | undefined, line: string): void {
  if (!path) return;
  try {
    appendFileSync(path, `${line}\n`);
  } catch {
    /* A full disk or a removed log directory must not fail the operation. */
  }
}

let opSequence = 0;
let digestOrder = 0;

/**
 * Reserves this call's place in the operation log at selection time, so concurrent calls
 * (three listings of one `branchRefs`) record in the order their backends were chosen.
 */
export function reserveGitOpSeq(): number {
  return opSequence++;
}

/** Appends one dispatched operation for the cross gate (`ACE_GIT_OP_LOG`). */
function appendOp(record: Omit<GitOpRecord, "pid">): void {
  appendLine(
    process.env.ACE_GIT_OP_LOG,
    JSON.stringify({ ...record, pid: process.pid } satisfies GitOpRecord),
  );
}

/**
 * Records one write for the digest gate (`ACE_GIT_DIGEST_LOG`): the
 * operation, its order in the test, and result-derived identity. Summaries
 * hold content identity only (trees, ref names, sequences): commit shas and
 * checkout paths embed the clock and the test's temp directories, so they
 * can never match across runs. Both backends log the same shape, so
 * `scripts/native-git-digest.ts` compares results, not backends. G4 and G5
 * extend `summary` with the trees the gate then requires identical.
 */
export function appendDigest(op: string, summary: string): void {
  const path = process.env.ACE_GIT_DIGEST_LOG;
  if (!path) return;
  appendLine(path, JSON.stringify({ op, order: digestOrder++, summary } satisfies GitDigestEntry));
}

/**
 * Whether the digest gate records: extra trees are read only in gate runs,
 * never in proof or benchmark runs.
 */
export function digestLogOn(): boolean {
  const log = process.env.ACE_GIT_DIGEST_LOG;
  return log !== undefined && log !== "";
}

/** Records one operation a part shell ran, for the cross gate (`ACE_GIT_OP_LOG`). */
export function recordGitOp(record: Omit<GitOpRecord, "pid">): void {
  appendOp(record);
}

/** Counts one fallback reason for `resourceUsage().nativeFallbacks`. */
export function countGitFallback(reason: string): void {
  countFallback(reason);
}

/** Fallback reasons counted for `resourceUsage().nativeFallbacks`. */
const fallbackReasons = new Map<string, number>();

function countFallback(reason: string): void {
  fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
}

/** The fallback counts since this process started, by reason. */
export function gitFallbackCounts(): Record<string, number> {
  return Object.fromEntries(fallbackReasons);
}

export type GitVerify = "off" | "strict" | "shadow";

/** `ACE_GIT_VERIFY=strict|shadow`; anything else refuses to start. */
export function gitVerify(): GitVerify {
  const mode = process.env.ACE_GIT_VERIFY;
  if (mode === undefined || mode === "") return "off";
  if (mode === "strict" || mode === "shadow") return mode;
  throw new Error(`ACE_GIT_VERIFY takes strict or shadow, not ${mode}`);
}

/** Calls the probe of a part whose every operation still defers; each item replaces its probe. */
function attemptNative(part: GitPart, op: string): string {
  const addon = gitAddon();
  switch (part) {
    case "refs":
      // `refs` replaces single processes inside the service (`native-refs.ts`), never a whole
      // operation: a whole-operation dispatch for it is a programming error.
      throw new Error("refs dispatches per process, not per operation");
    case "core":
      return addon.gitCoreProbe(op);
    case "reads":
      return addon.gitReadsProbe(op);
    case "writes":
      return addon.gitWritesProbe(op);
    case "checkpoints":
    case "snapshot-hash":
    case "status-gix":
      return addon.gitCheckpointsProbe(op);
  }
}

/**
 * Runs `typescript`, or the native path when `part` is on: under
 * `ACE_NATIVE_CROSS=ACE_GIT` the cross gate picks the backend per call,
 * otherwise the part's switch picks native. A stub deferral runs the
 * TypeScript path and counts the fallback; a real native failure throws.
 * G0: every native selection defers, so both backends behave the same.
 */
export async function runNativeOp<T>(
  part: GitPart,
  op: string,
  typescript: () => Promise<T>,
): Promise<T> {
  const selected: NativeBackend = gitCrossSelected() ?? "native";
  const seq = reserveGitOpSeq();
  if (selected === "typescript") {
    appendOp({ seq, op, part, selected, completed: "typescript" });
    return typescript();
  }
  try {
    const value = JSON.parse(attemptNative(part, op)) as T;
    // G5's comparison of a native-completed checkpoint against the CLI path
    // lands here with the native completion; G0 never completes natively.
    void gitVerify();
    appendOp({ seq, op, part, selected, completed: "native" });
    return value;
  } catch (error) {
    const deferral = stubDeferral(error);
    if (deferral === undefined) {
      appendOp({ seq, op, part, selected, completed: "native" });
      throwGitError(error);
    }
    appendOp({ seq, op, part, selected, completed: "typescript", fallback: "unimplemented" });
    countFallback("unimplemented");
    return typescript();
  }
}

/** The synchronous `runNativeOp`, for the calls that stay synchronous. */
export function runNativeOpSync<T>(part: GitPart, op: string, typescript: () => T): T {
  const selected: NativeBackend = gitCrossSelected() ?? "native";
  const seq = reserveGitOpSeq();
  if (selected === "typescript") {
    appendOp({ seq, op, part, selected, completed: "typescript" });
    return typescript();
  }
  try {
    const value = JSON.parse(attemptNative(part, op)) as T;
    void gitVerify();
    appendOp({ seq, op, part, selected, completed: "native" });
    return value;
  } catch (error) {
    const deferral = stubDeferral(error);
    if (deferral === undefined) {
      appendOp({ seq, op, part, selected, completed: "native" });
      throwGitError(error);
    }
    appendOp({ seq, op, part, selected, completed: "typescript", fallback: "unimplemented" });
    countFallback("unimplemented");
    return typescript();
  }
}

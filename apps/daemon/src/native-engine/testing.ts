// SPDX-License-Identifier: Apache-2.0
/**
 * The engine test seam (E5.1 step 12): builds the whole native engine on a real Store, with a
 * `ManualClock`, scripted ports and the probe hooks the seam tests need. Test-only: it is the
 * scaffolding every E5 item shows its native behaviour through, and it moves with them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { Engine, type EngineOptions } from "../engine/index.ts";
import { ManualClock } from "../engine/test-support.ts";
import { Store } from "../store.ts";
import { NativeEngine } from "./engine.ts";
import { FrameTable, type ActorContext } from "./actor.ts";
import { probeFor } from "./probe.ts";
import type { Translator } from "@ace/engine-api";

export interface ProbeTurns {
  turns: number[];
  polls: number;
  longestPollUs: number;
  slowPolls: number;
}

/** What the probe exposes: executor and store hooks, with no thread behaviour. */
export interface EngineProbe {
  spawn(lane: "control" | "work", script: readonly ProbeStep[]): void;
  /** One Rust transaction now, inside whatever transaction the caller has open. */
  writeNow(events: readonly unknown[], defer?: string, row?: string): void;
  defer(threadId: string): void;
  claim(): string;
  turns(): Promise<ProbeTurns>;
  woken(): string[];
  emptyCandidates(): void;
  stats(): Promise<ProbeTurns>;
  /** A close step that awaits `port`: the deadline test's module-step stall. */
  stallCloseStep(port: () => Promise<void>): void;
  /** A worker task awaiting `port` that never settles; returns once the port is armed. */
  stallWorker(
    threadId: string,
    worker: string,
    port: string,
    portPromise?: () => Promise<unknown>,
  ): void;
  /** E5.2's scripted session: its context, its abort count, its retirement and its log. */
  attachSession(threadId: string, spec: AttachSpec): Promise<ProbeSession>;
  /** The next `apply` calls throw a busy error before writing. */
  failApply(threadId: string, times: number): void;
  /** The next live `persist` calls throw a busy error. */
  failPersist(threadId: string, times: number): void;
  /** The next live `persist` calls throw a fatal error, so the batch is quarantined. */
  failPersistFatal(threadId: string, times: number): void;
  /** The Rust tokens still held for live snapshots. */
  liveTokens(): number;
  /** The repository reports a Cursor SDK thread, so the journal path runs. */
  useCursorRoute(threadId: string): void;
  /** The next attachment lookups throw a busy error. */
  failAttachment(threadId: string, times: number): void;
  /** The next applies fail with a non-retryable error. */
  failApplyFatal(threadId: string, times: number): void;
  /** Invalidates a provisional actor's reservation before its first poll. */
  loseReservation(threadId: string): void;
  /** Seals the pending frame batch now, as a flush would. */
  seal(threadId: string): void;
  /** Queues one labelled operation behind the frames sealed before it. */
  enqueue(threadId: string, label: string): void;
  /** Queues what `onExit` runs: a retire op behind the batch. */
  enqueueRetire(threadId: string): void;
  /** Runs the front op inside an open transaction: the outermost rule must fail it. */
  runInTransaction(threadId: string): void;
  /** The actor's generation now. */
  generation(threadId: string): number;
  /** Wakers the engine has registered. */
  registeredWakers(): number;
  /** One native frame through the native intake, with its acknowledgement. */
  nativeFrame(
    threadId: string,
    generation: number,
    seq: number,
    channel: string,
    data: string,
  ): Promise<void>;
  /** One frame through the bridge's own path (payload limits and their warning). */
  bridgeFrame(
    threadId: string,
    generation: number,
    seq: number,
    channel: string,
    data: string,
    started?: number,
  ): void;
  /** Mirrors the actor's flow into a native gate once, recording `set_paused`. */
  nativeFlow(threadId: string): void;
  /** Installs the probe repository and links without creating an actor. */
  useDeps(threadId: string): void;
  /** Makes the probe's native translator the thread's translator. */
  attachNativeTranslator(threadId: string): void;
  /** What an `onExit` does: retires the generation (the probe's). */
  retire(threadId: string): void;
  /** The thread's apply entries, as JSON. */
  applied(threadId: string): string;
  /** JavaScript frame objects the shell still holds: a refused batch must release its own. */
  liveFrames(): number;
  /** The labels scripted tasks marked, in order. */
  marks(): string[];
  /** The flush depth and how many actor seals flushes have asked for. */
  flushState(): { depth: number; seals: number };
  /** Registers a counted waker for `thread`, as an actor task would. */
  registerWaker(thread: string): void;
  /** Drops the waker `thread` registered, as its actor going away does. */
  unregisterWaker(thread: string): void;
  /** Wakes the counted waker of `thread` has received. */
  wakeCount(thread: string): number;
  /** The one JS callback a `js` step runs. */
  setCallback(callback: () => void): void;
  /** Timers the binding still has armed. */
  timerCount(): number;
  /** The transaction shell's bookkeeping: open frames, top aliases and released lists. */
  stackEntries(): { frames: number; released: number };
}

/** What `attachSession` scripts. */
export interface AttachSpec {
  translator: Translator;
  /** The probe repository's answer to `stream()`. */
  stream?: "deltas" | "never";
  generation?: number;
}

/** What one `apply` did. */
export interface ProbeApplied {
  facts: number;
  frames: number;
  outermost: boolean;
  committed: boolean;
  streamed: boolean;
  generation: number;
}

/** The probe's transcript. */
export interface ProbeActorLog {
  aborted: number;
  wakes: number;
  released: number;
  diagnostics: unknown[];
  applied: ProbeApplied[];
  expired: number[];
  retired: number[];
  snapshots: string[];
  live: unknown[];
  enqueued: string[];
  flowed: boolean[];
  /** Each real native-path acknowledgement: `ok` or `rejected:<message>`. */
  nativeAcks: string[];
  /** Every attachment lookup: a retried busy lookup shows two. */
  attachmentLookups: number;
  /** The facts each apply received, in order. */
  facts: Record<string, unknown>[];
  /** What the fold did, in order. */
  order: string[];
  /** Each enqueued op's own transaction: whether it ran outermost. */
  opsOutermost: boolean[];
  /** Each Cursor record call's entries. */
  journal: {
    beginsTurn?: boolean;
    frame?: { channel?: string; seq?: number; dir?: string; t?: number };
  }[];
  /** Each Cursor record call: whether a transaction was open. */
  journalInTransaction: boolean[];
}

/** One scripted session. */
export interface ProbeSession {
  context: ActorContext;
  aborted(): number;
  retire(): void;
  log(): ProbeActorLog;
}

export type ProbeStep =
  | { op: "timer"; ms: number }
  | { op: "defer"; thread: string }
  | {
      op: "write";
      events: readonly unknown[];
      defer?: string;
      fail?: boolean;
      /** Runs the callback inside the open Rust transaction, before `nested`. */
      js?: boolean;
      /** Inserts this label in `probe_rows` through the shared connection, in the frame. */
      row?: string;
      nested?: { events: readonly unknown[]; defer?: string };
    }
  | { op: "flush" }
  | { op: "mark"; label: string }
  | { op: "js" };

/** Every port call, in order, with its arguments. */
export interface PortLog {
  calls: { port: string; args: unknown[] }[];
  reset(): void;
}

export interface EngineSeam {
  store: Store;
  engine: Engine;
  clock: ManualClock;
  ports: PortLog;
  probe: EngineProbe;
  close(): Promise<void>;
}

export interface EngineSeamInput {
  seed?: (store: Store) => void | Promise<void>;
  seedWithTypeScript?: { script: string; args?: readonly string[] };
  options?: Partial<EngineOptions> & { home?: string };
}

function portLog(): PortLog {
  const calls: { port: string; args: unknown[] }[] = [];
  return {
    calls,
    reset() {
      calls.length = 0;
    },
  };
}

/** Wraps the ports a seam test watches, leaving the rest of the options untouched. */
function logged(options: Partial<EngineOptions>, clock: ManualClock, log: PortLog) {
  const given = options.clock;
  const clockPort = {
    now: () => {
      log.calls.push({ port: "clock.now", args: [] });
      return (given?.now ?? clock.now)();
    },
    setTimer: (callback: () => void, delay: number) => {
      log.calls.push({ port: "clock.setTimer", args: [delay] });
      return (given?.setTimer ?? clock.setTimer)(callback, delay);
    },
  };
  const onError = options.onError;
  return {
    ...options,
    clock: clockPort,
    // The 1 ms batch timer is the same manual clock, so a seam test advances it explicitly.
    batchScheduler: options.batchScheduler ?? clock,
    onError: (error: unknown) => {
      log.calls.push({ port: "onError", args: [String(error)] });
      (onError ?? (() => {}))(error);
    },
    // Only when the test gave one: without the ready ports the sync branch runs, which needs
    // no E5.6/E5.8 preparation.
    ...(options.providersActivated ? { providersActivated: options.providersActivated } : {}),
  };
}

/**
 * A whole native engine on a temp home: `ACE_ENGINE=native`, `ACE_STORE=native` and the
 * `transactions` writer, built exactly as `new Engine` builds it. Without the probe feature
 * this throws; it never skips.
 */
export async function engineSeam(input: EngineSeamInput = {}): Promise<EngineSeam> {
  if (engineBackend() !== "native")
    throw new Error("the engine seam needs ACE_ENGINE=native and ACE_STORE=native");
  const home = input.options?.home ?? mkdtempSync(join(tmpdir(), "ace-engine-seam-"));
  const path = join(home, "events.sqlite");
  const clock = new ManualClock();
  // The store's live buffer shares the manual clock, so a deadline fires when the test says.
  const store = new Store(path, console.error, {
    bufferScheduler: { delay: (callback: () => void, ms: number) => clock.setTimer(callback, ms) },
  });
  if (input.seed) await input.seed(store);
  if (input.seedWithTypeScript) {
    const { spawnSync } = await import("node:child_process");
    const env: NodeJS.ProcessEnv = { ...process.env, ACE_HOME: home };
    delete env.ACE_ENGINE;
    delete env.ACE_NATIVE_CROSS;
    const child = spawnSync(
      process.execPath,
      [input.seedWithTypeScript.script, ...(input.seedWithTypeScript.args ?? [])],
      { env, stdio: "inherit" },
    );
    if (child.status !== 0)
      throw new Error(`the TypeScript seed script exited ${String(child.status)}`);
  }
  const ports = portLog();
  const options = logged(input.options ?? {}, clock, ports);
  const engine = new Engine(store, options);
  const native = (engine as unknown as NativeEngine).binding;
  if (native === undefined) throw new Error("the engine seam built the TypeScript engine");
  const probe = probeFor(
    native,
    new FrameTable(() => clock.now()),
    engine as unknown as NativeEngine,
    options,
    clock,
  );
  probe.emptyCandidates();
  return {
    store,
    engine,
    clock,
    ports,
    probe,
    async close() {
      // E5.1's close reports its unported module step; cleanup still runs either way.
      await engine.close().catch(() => {});
      await store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

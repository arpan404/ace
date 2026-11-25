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
import { NativeEngine, type NativeEngineHandle } from "./engine.ts";
import { FrameTable, actorContext, type ActorContext } from "./actor.ts";
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
  const store = new Store(path);
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
  const clock = new ManualClock();
  const ports = portLog();
  const options = logged(input.options ?? {}, clock, ports);
  const engine = new Engine(store, options);
  const native = (engine as unknown as NativeEngine).binding;
  if (native === undefined) throw new Error("the engine seam built the TypeScript engine");
  const probe = probeFor(native, new FrameTable(), engine as unknown as NativeEngine, options);
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

function parseTurns(text: string): ProbeTurns {
  const turns = JSON.parse(text) as number[];
  return {
    turns,
    polls: turns.reduce((sum, polls) => sum + polls, 0),
    longestPollUs: 0,
    slowPolls: 0,
  };
}

function probeFor(
  native: NativeEngineHandle,
  frames: FrameTable,
  facade: NativeEngine,
  options: Partial<EngineOptions>,
): EngineProbe {
  const required = (name: string) => {
    const member = native[name];
    if (typeof member !== "function")
      throw new Error(
        "the engine probe is not built: cargo build --release -p ace-daemon-node --features engine-probe",
      );
    return member.bind(native) as (...args: unknown[]) => unknown;
  };
  const call = required("probeSpawn");
  const writeNow = required("probeWriteNow") as (step: string) => void;
  const flushState = required("probeFlushState") as () => string;
  const defer = required("probeDefer") as (thread: string) => void;
  const claim = required("probeClaim") as () => string;
  const turnLog = required("probeTurns") as () => string;
  const woken = required("probeWoken") as () => string[];
  const emptyCandidates = required("probeEmptyCandidates") as () => void;
  const stats = required("probeStats") as () => string;
  const settle = native.settlePromise?.bind(native);
  if (settle === undefined) throw new Error("the engine binding has no settlePromise");
  return {
    spawn: (lane, script) => {
      call(lane, JSON.stringify(script));
    },
    writeNow: (events, deferred, row) => {
      writeNow(
        JSON.stringify({
          op: "write",
          events,
          ...(deferred ? { defer: deferred } : {}),
          ...(row ? { row } : {}),
        }),
      );
    },
    flushState: () => JSON.parse(flushState()) as { depth: number; seals: number },
    registerWaker: (thread) => required("probeRegisterWaker")(thread),
    unregisterWaker: (thread) => required("probeUnregisterWaker")(thread),
    wakeCount: (thread) => required("probeWakeCount")(thread) as number,
    defer,
    claim,
    async turns() {
      return parseTurns(turnLog());
    },
    woken,
    emptyCandidates,
    async stats() {
      const parsed = JSON.parse(stats()) as {
        polls: number;
        longestPollUs: number;
        slowPolls: number;
      };
      const list = parseTurns(turnLog());
      return { ...list, ...parsed };
    },
    stallCloseStep(port) {
      const id = required("probeStallCloseStep")() as number;
      Promise.resolve(port()).then(
        () => settle(id, true),
        (error: unknown) => settle(id, false, String(error)),
      );
    },
    stallWorker(threadId, worker, port, portPromise) {
      const id = required("probeStallWorker")(threadId, worker, port) as number;
      if (portPromise !== undefined)
        Promise.resolve(portPromise()).then(
          () => settle(id, true),
          (error: unknown) => settle(id, false, String(error)),
        );
    },
    marks: () => required("probeMarks")() as string[],
    timerCount: () => required("probeTimerCount")() as number,
    stackEntries: () =>
      JSON.parse(required("probeStackEntries")() as string) as {
        frames: number;
        released: number;
      },
    setCallback: (callback) => {
      required("probeSetCallback")(callback);
    },
    async attachSession(threadId, spec) {
      const attach = required("probeAttachSession") as (
        thread: string,
        stream: string | null,
        generation: number | null,
      ) => void;
      const retire = required("probeRetire") as (thread: string) => void;
      const logOf = required("probeActorLog") as (thread: string) => string;
      frames.attach(threadId, spec.translator);
      // The context installs the batch helper, so it comes before the actor starts.
      const context = actorContext(
        native,
        frames,
        facade,
        threadId,
        spec.generation ?? 0,
        options.limits?.maxFrameBytes ?? 4 * 1024 * 1024,
      ) as ActorContext;
      attach(threadId, spec.stream ?? null, spec.generation ?? null);
      return {
        context,
        aborted: () => (JSON.parse(logOf(threadId)) as ProbeActorLog).aborted,
        retire: () => retire(threadId),
        log: () => JSON.parse(logOf(threadId)) as ProbeActorLog,
      };
    },
  };
}

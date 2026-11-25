// SPDX-License-Identifier: Apache-2.0
/**
 * The probe's shell half (E5.2 step 15): the binding's probe members behind the `EngineProbe`
 * interface the seam tests drive. Split out of `testing.ts` to keep each file one responsibility.
 */
import type { NativeEngine, NativeEngineHandle } from "./engine.ts";
import type { ManualClock } from "../engine/test-support.ts";
import type { EngineOptions } from "../engine/engine-options.ts";
import { FrameTable, actorContext, type ActorContext } from "./actor.ts";
import type { EngineProbe, ProbeActorLog, ProbeTurns } from "./testing.ts";

/** The turn log as `ProbeTurns`. */
function parseTurns(text: string): ProbeTurns {
  const turns = JSON.parse(text) as number[];
  return {
    turns,
    polls: turns.reduce((sum, polls) => sum + polls, 0),
    longestPollUs: 0,
    slowPolls: 0,
  };
}

export function probeFor(
  native: NativeEngineHandle,
  frames: FrameTable,
  facade: NativeEngine,
  options: Partial<EngineOptions>,
  clock: ManualClock,
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
  const stats = required("probeStats") as () => string;
  const settle = native.settlePromise?.bind(native);
  if (settle === undefined) throw new Error("the engine binding has no settlePromise");
  const nativeBatches = new Map<string, Promise<void>>();
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
    apply: (threadId: string, facts: readonly unknown[], now: number) =>
      required("probeApply")(threadId, JSON.stringify(facts), now),
    applyRolledBack: (threadId: string, facts: readonly unknown[], now: number) =>
      required("probeApplyRolledBack")(threadId, JSON.stringify(facts), now),
    passThroughCollaborators: () => {
      required("probePassThroughCollaborators")();
    },
    stream: (threadId: string, facts: readonly unknown[], now: number) =>
      required("probeStream")(threadId, JSON.stringify(facts), now) as boolean,
    budget: () =>
      JSON.parse(required("probeBudget")() as string) as {
        entries: number;
        bytes: number;
        evictions: number;
      },
    resident: () => required("probeResident")() as number,
    holds: (threadId: string) => required("probeHolds")(threadId) as boolean,
    rollbackGeneration: () => required("probeRollbackGeneration")() as number,
    quarantine: (threadId: string) => required("probeQuarantine")(threadId),
    candidatePages: () => JSON.parse(required("probeCandidatePages")() as string) as string[][],
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
      // The context installs the batch helper, so it comes before the actor starts.
      const context = actorContext(
        native,
        frames,
        facade,
        threadId,
        spec.generation ?? 0,
        options.limits?.maxFrameBytes ?? 4 * 1024 * 1024,
        spec.translator,
      ) as ActorContext;
      attach(threadId, spec.stream ?? null, spec.generation ?? null);
      return {
        context,
        aborted: () => (JSON.parse(logOf(threadId)) as ProbeActorLog).aborted,
        retire: () => retire(threadId),
        log: () => JSON.parse(logOf(threadId)) as ProbeActorLog,
      };
    },
    failApply: (thread, times) => required("probeFailApply")(thread, times),
    failPersist: (thread, times) => required("probeFailPersist")(thread, times),
    failPersistFatal: (thread, times) => required("probeFailPersistFatal")(thread, times),
    liveTokens: () => required("probeLiveTokens")() as number,
    useCursorRoute: (thread) => required("probeUseCursorRoute")(thread),
    failAttachment: (thread, times) => required("probeFailAttachment")(thread, times),
    failApplyFatal: (thread, times) => required("probeFailApplyFatal")(thread, times),
    loseReservation: (thread) => required("probeLoseReservation")(thread),
    seal: (thread) => required("probeSeal")(thread),
    schedule: (thread) => required("probeSchedule")(thread),
    enqueue: (thread, label) => required("probeEnqueue")(thread, label),
    enqueueRetire: (thread) => required("probeEnqueueRetire")(thread),
    runInTransaction: (thread) => required("probeRunInTransaction")(thread),
    generation: (thread) => required("probeGeneration")(thread) as number,
    registeredWakers: () => required("probeRegisteredWakers")() as number,
    stopActor: (thread) => required("probeStopActor")(thread),
    stoppingCount: () => required("probeStoppingCount")() as number,
    liveFrames: () => facade.frames.size,
    nativeFrame(threadId, generation, seq, channel, data) {
      const open = nativeBatches.get(threadId);
      if (open !== undefined) {
        // Decision 4: every frame of an open batch gets that batch's promise.
        required("probeNativeFrame")(threadId, generation, seq, channel, data);
        return open;
      }
      const answer = required("probeNativeFrame")(
        threadId,
        generation,
        seq,
        channel,
        data,
      ) as string;
      if (!answer.startsWith("batch:")) return Promise.resolve();
      const promise = facade.promiseOf(Number(answer.slice("batch:".length)));
      if (promise === undefined) return Promise.resolve();
      const tracked = promise.finally(() => nativeBatches.delete(threadId));
      nativeBatches.set(threadId, tracked);
      return tracked;
    },
    bridgeFrame(threadId, generation, seq, channel, data, started = clock.now()) {
      required("probeBridgeFrame")(threadId, generation, seq, channel, data, clock.now(), started);
    },
    nativeFlow: (thread) => required("probeNativeFlow")(thread),
    useDeps: (thread) => required("probeUseDeps")(thread),
    attachNativeTranslator: (thread) => required("probeAttachNativeTranslator")(thread),
    retire: (thread) => required("probeRetire")(thread),
    applied: (thread) => required("probeApplied")(thread) as string,
  };
}

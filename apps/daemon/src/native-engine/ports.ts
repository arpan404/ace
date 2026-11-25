// SPDX-License-Identifier: Apache-2.0
/**
 * The native engine's ports (E5.1): every `EngineOptions` callback the engine calls on the JS
 * thread, as the plain object the binding keeps. Timers go through the injected clock, promises
 * through ids the binding settles, and transactions through the store's own shell, so a
 * Rust-opened transaction shares the JavaScript context's lifecycle.
 */
import { systemClock } from "../engine/actor.ts";
import type { EngineClock } from "../engine/actor.ts";
import type { EngineOptions } from "../engine/engine-options.ts";
import type { Store } from "../store.ts";
import type { NativeTransactionShell } from "./engine.ts";

/** What the binding's object holds besides the callbacks. */
export interface EngineInputsJson {
  limits?: Partial<Record<string, number>>;
  idleMs?: number;
  inputs: {
    preferences: boolean;
    models: boolean;
    providersActivated: boolean;
    resolveSilenceMs: boolean;
  };
}

/** What the facade tells the ports when a promise or close settles. */
export interface PortHost {
  frameCall(): number;
  releaseFrames(handles: readonly number[]): void;
  settleCall(call: number, error: string | null): void;
  rejectPending(): void;
  finishClose(): void;
  resolveReady(error: string | null): void;
  resolveClose(error: string | null): void;
  timerFired(key: number): void;
  settlePromise(id: number, ok: boolean, message?: string): void;
  /** The live buffer's token callbacks (`repository.ts:396`-`:409`, E5.3). */
  livePersist(token: number): void;
  liveCommitted(token: number): void;
  liveQuarantined(thread: string, message: string): void;
}

export interface EngineBindings {
  options: string;
  registry: string;
  clockNow(): number;
  armTimer(key: number, ms: number): () => void;
  armBatchTimer(key: number, ms: number): () => void;
  threadId(): string;
  commandId(): string;
  nextId(kind: string): string;
  report(message: string): void;
  providersActivated(id: number): void;
  waitForProvider(provider: string, id: number): void;
  resolveReady(error: string | null): void;
  resolveClose(error: string | null): void;
  openTransaction(): { token: number; outermost: boolean };
  closeTransaction(token: number, error: string | null): void;
  isTransactionOpen(): boolean;
  appendEvents(json: string): void;
  /** `store.appendEvents(threadId, payloads, at)`: the store's one event writer (E5.3). */
  writeEvents(threadId: string, payloadsJson: string, at: number): void;
  headSeq(): number;
  hasLiveWrite(threadId: string): boolean;
  rollbackGeneration(): number;
  getThread(id: string): string | null;
  capRaw(rawJson: string, threadId: string): string;
  prepareLiveWrite(bytes: number): void;
  /**
   * E5.2 owns the live buffer. E5.3 declares the port and its token callbacks; until E5.2 binds
   * it, buffering a live write fails at the call.
   */
  bufferLiveWrite(threadId: string, eventsJson: string, at: number, token: number): void;
  frameCall(): number;
  releaseFrames(json: string): void;
  settleCall(call: number, error: string | null): void;
  rejectPending(): void;
  finishClose(): void;
}

/** The `options` JSON the binding reads: limits, idleMs and which ready ports were given. */
export function engineInputs(options: EngineOptions): EngineInputsJson {
  return {
    ...(options.limits ? { limits: options.limits as Record<string, number> } : {}),
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    inputs: {
      preferences: options.recovery?.preferences !== undefined,
      models: options.models !== undefined,
      providersActivated: options.providersActivated !== undefined,
      resolveSilenceMs: options.resolveSilenceMs !== undefined,
    },
  };
}

/** Settles an optional promise port at once when the option was not given. */
function settleNow(host: PortHost, id: number, promise: Promise<unknown> | undefined): void {
  if (promise === undefined) {
    host.settlePromise(id, true);
    return;
  }
  promise.then(
    () => host.settlePromise(id, true),
    (error: unknown) => host.settlePromise(id, false, String(error)),
  );
}

/**
 * The binding's ports object. The clock is the injected one, so a `ManualClock` in a test fires
 * timers in its own order and the waiting task resumes in the next pump.
 */
export function engineBindings(input: {
  options: EngineOptions;
  registryJson: string;
  store: Store;
  shell: NativeTransactionShell;
  host: PortHost;
}): EngineBindings {
  const { options, registryJson, store, shell, host } = input;
  const clock: EngineClock = options.clock ?? systemClock;
  const batchScheduler = options.batchScheduler ?? systemClock;
  return {
    options: JSON.stringify(engineInputs(options)),
    registry: registryJson,
    clockNow: () => clock.now(),
    armTimer: (key, ms) => clock.setTimer(() => host.timerFired(key), ms),
    armBatchTimer: (key, ms) => batchScheduler.setTimer(() => host.timerFired(key), ms),
    threadId: () => (options.threadId ?? (() => crypto.randomUUID()))(),
    commandId: () => (options.commandId ?? (() => crypto.randomUUID()))(),
    nextId: (kind) => (options.ids ? options.ids.next(kind as never) : ""),
    report: (message) => (options.onError ?? console.error)(new Error(message)),
    providersActivated: (id) => settleNow(host, id, options.providersActivated),
    waitForProvider: (provider, id) =>
      settleNow(host, id, options.waitForProvider?.(provider as never)),
    resolveReady: (error) => host.resolveReady(error),
    resolveClose: (error) => host.resolveClose(error),
    openTransaction: () => {
      const frame = shell.open();
      return { token: frame.token, outermost: frame.top };
    },
    closeTransaction: (token, error) =>
      shell.close(
        token,
        error === null ? { threw: false } : { threw: true, error: new Error(error) },
      ),
    isTransactionOpen: () => shell.transactionOpen,
    appendEvents: (json) => shell.appendEvents(json),
    writeEvents: (threadId, payloadsJson, at) =>
      store.appendEvents(threadId as never, JSON.parse(payloadsJson) as never, at),
    headSeq: () => store.headSeq(),
    hasLiveWrite: (threadId) => store.hasLiveWrite(threadId as never),
    rollbackGeneration: () => store.rollbackGeneration(),
    getThread: (id) => {
      const thread = store.getThread(id as never);
      return thread === undefined ? null : JSON.stringify(thread);
    },
    capRaw: (rawJson, threadId) =>
      JSON.stringify(store.capRaw(JSON.parse(rawJson) as never, threadId as never)),
    prepareLiveWrite: (bytes) => store.prepareLiveWrite(bytes),
    bufferLiveWrite: (threadId, eventsJson, at, token) =>
      store.bufferLiveWrite(threadId as never, JSON.parse(eventsJson) as never, at, {
        // The buffer calls these back inside its flush transaction; the engine settles the
        // snapshot it pinned under this token (E5.3 step 8).
        persist: () => host.livePersist(token),
        committed: () => host.liveCommitted(token),
      }),
    frameCall: () => host.frameCall(),
    releaseFrames: (json) => host.releaseFrames(JSON.parse(json) as number[]),
    settleCall: (call, error) => host.settleCall(call, error),
    rejectPending: () => host.rejectPending(),
    finishClose: () => host.finishClose(),
  };
}

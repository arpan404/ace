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
  settleCall(call: number, error: string | null): void;
  rejectPending(): void;
  finishClose(): void;
  resolveReady(error: string | null): void;
  resolveClose(error: string | null): void;
  timerFired(key: number): void;
  settlePromise(id: number, ok: boolean, message?: string): void;
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
  frameCall(): number;
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
  store: NativeTransactionShell;
  host: PortHost;
}): EngineBindings {
  const { options, registryJson, store, host } = input;
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
      const frame = store.open();
      return { token: frame.token, outermost: frame.top };
    },
    closeTransaction: (token, error) =>
      store.close(
        token,
        error === null ? { threw: false } : { threw: true, error: new Error(error) },
      ),
    isTransactionOpen: () => store.transactionOpen,
    appendEvents: (json) => store.appendEvents(json),
    frameCall: () => host.frameCall(),
    settleCall: (call, error) => host.settleCall(call, error),
    rejectPending: () => host.rejectPending(),
    finishClose: () => host.finishClose(),
  };
}

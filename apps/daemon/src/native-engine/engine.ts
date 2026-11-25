// SPDX-License-Identifier: Apache-2.0
/**
 * The native engine facade (E5.1): every public member of `Engine` with the same timing, over
 * the addon. The members no item has ported live in `unported.ts` and throw
 * `NativeEngineIncomplete`; nothing ever falls back to the TypeScript engine.
 */
import { nativeHandle } from "@ace/provider-kit/sqlite";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import type { EngineOptions } from "../engine/engine-options.ts";
import type { Store } from "../store.ts";
import type { CommandHandler } from "../commands.ts";
import type { EngineSurface } from "../engine/index.ts";
import type { ThreadId } from "@ace/protocol";
import { personCommand } from "../engine/person-command.ts";
import { AdapterRegistry } from "../engine/registry.ts";
import { engineBindings, type PortHost } from "./ports.ts";
import { FrameTable } from "./actor.ts";
import { liveStorePort } from "./frames.ts";
import { systemClock } from "../engine/actor.ts";
import { receiptHandler, type Receipt } from "./commands.ts";
import {
  closed,
  incomplete,
  recordEvidence,
  type DatabaseHandle,
  type NativeEngineHandle,
  type Settled,
} from "./contracts.ts";
import { UnportedMembers } from "./unported.ts";
import { queuePage, queueRetains, queueSnapshot } from "./queue.ts";
import { commandExecution, commandFailure, prioritizeSubagentResult } from "./intents.ts";
import { inputFate } from "./inputs.ts";
import { openEngineData } from "./open.ts";

export type { NativeEngineHandle, NativeTransactionShell } from "./contracts.ts";
export { incomplete };

export class NativeEngine extends UnportedMembers implements EngineSurface {
  /** The addon handle, for the test seam's probe hooks. */
  readonly binding: NativeEngineHandle;
  private readonly registry: AdapterRegistry;
  readonly handler: CommandHandler;
  readonly internalHandler: CommandHandler;
  private readyPromise!: Promise<void>;
  private closePromise?: Promise<void>;
  private readySettled!: Settled;
  private closeSettled!: Settled;
  private readyFlag = false;
  private closingFlag = false;
  private readonly calls = new Map<number, Settled>();
  /** The session frames the shell holds, released by handle when the engine refuses a batch. */
  readonly frames: FrameTable;
  private nextCall = 1;
  private holders = 0;
  private stopObserving?: () => void;
  private stopLiveStore?: () => void;
  private ownershipFence?: Parameters<EngineSurface["bindOwnershipFence"]>[0];
  private commandPolicy?: (command: unknown, accept: () => unknown) => unknown;
  private hostInteractions?: (command: unknown) => unknown;
  private deletionPolicy?: (id: ThreadId, commandId: string) => void;
  private externalTaskStop?: { prefix: string; stop: (id: string, threadId: ThreadId) => void };

  constructor(store: Store, options: EngineOptions = {}) {
    super();
    recordEvidence();
    this.frames = new FrameTable(() => (options.clock ?? systemClock).now());
    // The opener: the TypeScript repository's schema setup, in today's order (E5.3 step 1).
    openEngineData(store, options, () => (options.clock ?? systemClock).now());
    this.registry = options.registry ?? new AdapterRegistry();
    const shell = store.nativeTransactionShell;
    if (!shell) throw new Error("ACE_ENGINE needs ACE_STORE_WRITER=…,transactions");
    const database = nativeHandle(shell.db as unknown as object) as DatabaseHandle | undefined;
    if (!database)
      throw new Error(`ACE_ENGINE=native needs the engine addon at ${sessionsAddonPath()}`);
    let native: NativeEngineHandle | undefined;
    const host: PortHost = {
      frameCall: () => this.alloc(),
      releaseFrames: (handles) => this.frames.releaseHandles(handles),
      livePersist: (token) => native?.livePersist?.(token),
      liveCommitted: (token) => native?.liveCommitted?.(token),
      liveQuarantined: (thread, message) => native?.liveQuarantined?.(thread, message),
      settleCall: (call, error) => this.settle(call, error),
      rejectPending: () => this.rejectPending(),
      finishClose: () => this.finishClose(),
      resolveReady: (error) => this.finishReady(error),
      resolveClose: (error) => this.finishClosePromise(error),
      timerFired: (key) => native?.timerFired?.(key),
      settlePromise: (id, ok, message) => native?.settlePromise?.(id, ok, message),
    };
    let entries = "[]";
    this.stopObserving = this.registry.observe((list) => {
      entries = JSON.stringify(
        list.map((entry) => ({
          provider: entry.provider,
          backend: entry.backend ?? null,
          current: entry.current,
          adapter: entry.handle,
          capabilities: entry.capabilities,
          discovery: entry.discovery,
        })),
      );
      native?.registryChanged?.(entries);
    });
    const bindings = engineBindings({
      options,
      registryJson: entries,
      store,
      shell,
      host,
    });
    const pump = () => {
      if (native?.pump?.() === "rearm") setImmediate(pump);
    };
    const handle = database.nativeEngine(bindings, pump);
    native = handle;
    this.binding = handle;
    // The engine's live writes go through the connection's one buffer (E5.2 step 16).
    this.stopLiveStore = liveStorePort(store, handle);
    this.readyPromise = new Promise((resolve, reject) => {
      this.readySettled = { resolve, reject };
      this.hold();
    });
    const internal = receiptHandler({
      closing: () => this.closingFlag,
      ready: () => this.readyFlag,
      store,
      fence: (threadId) => this.ownershipFence?.(threadId as never),
      host: (command) => this.hostInteractions?.(command),
      policy: (command, accept) => this.commandPolicy?.(command, accept),
      receipt: (value) => (this.member("handle", "E5.4d") as Receipt)(value),
    });
    this.internalHandler = internal;
    this.handler = {
      handle: (command, context) => internal.handle(personCommand(command), context),
    };
  }

  /** The binding member, or the item that lands it. */
  private member(name: string, item: string): (...args: unknown[]) => unknown {
    const member = this.binding[name];
    if (typeof member !== "function") throw incomplete(name, item);
    return member.bind(this.binding) as (...args: unknown[]) => unknown;
  }

  /** A pending facade promise: the binding refs the threadsafe function at 0 -> 1. */
  private hold(): void {
    this.holders += 1;
    this.binding.hold?.();
  }

  private releaseHolder(): void {
    if (this.holders === 0) return;
    this.holders -= 1;
    this.binding.releaseHold?.();
  }

  private call<T = void>(invoke: (call: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const call = this.nextCall++;
      this.calls.set(call, { resolve: resolve as (value: undefined) => void, reject });
      this.hold();
      try {
        invoke(call);
      } catch (error) {
        this.calls.delete(call);
        this.releaseHolder();
        reject(error as Error);
      }
    });
  }

  private settle(call: number, error: string | null): void {
    const pending = this.calls.get(call);
    if (pending === undefined) return;
    this.calls.delete(call);
    this.releaseHolder();
    if (error === null) pending.resolve(undefined);
    else pending.reject(error === "Engine closed" ? closed() : new Error(error));
  }

  private rejectPending(): void {
    for (const pending of this.calls.values()) pending.reject(closed());
    this.calls.clear();
    while (this.holders > 0) this.releaseHolder();
    if (!this.readyFlag) {
      this.readyFlag = true;
      this.readySettled.reject(closed());
    }
  }

  private finishReady(error: string | null): void {
    this.readyFlag = true;
    this.releaseHolder();
    if (error === null) this.readySettled.resolve(undefined);
    else this.readySettled.reject(new Error(error));
  }

  private finishClosePromise(error: string | null): void {
    if (error === null) this.closeSettled.resolve(undefined);
    else this.closeSettled.reject(new Error(error));
  }

  private finishClose(): void {
    this.closingFlag = true;
    this.releaseHolder();
    this.stopObserving?.();
    this.stopLiveStore?.();
    // The terminal cleanup releases the threadsafe function last.
    this.binding.release?.();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * A promise the binding settles by its call id (E5.2's frame acknowledgements): one per batch,
   * so a 256-frame batch costs one deferred.
   */
  frameCall(): { promise: Promise<void>; call: number } {
    let call = 0;
    const promise = this.call<void>((id) => {
      call = id;
    });
    // A frame the actor accepts without taking a promise still gets one; close must not see it
    // as an unhandled rejection.
    void promise.catch(() => {});
    return { promise, call };
  }

  /** How many batch promises were allocated: one per batch, whatever the frame count. */
  allocatedFrameCalls = 0;

  /** One promise for the batch a frame starts (decision 4): the binding settles it by call. */
  alloc(): number {
    this.allocatedFrameCalls += 1;
    const { promise, call } = this.frameCall();
    this.framePromiseByCall.set(call, promise);
    const forget = () => this.framePromiseByCall.delete(call);
    void promise.then(forget, forget);
    return call;
  }

  /** The promise `alloc` made, so a joined frame returns the batch's own. */
  promiseOf(call: number): Promise<void> | undefined {
    return this.framePromiseByCall.get(call);
  }

  private readonly framePromiseByCall = new Map<number, Promise<void>>();

  flush(): Promise<void> {
    // Admission closed: no holder is taken and nothing is enqueued onto the shut executor.
    if (this.closingFlag) return Promise.reject(closed());
    return this.call((call) => this.member("startFlush", "E5.1")(call));
  }

  close(): Promise<void> {
    this.closePromise ??= new Promise<void>((resolve, reject) => {
      this.closeSettled = { resolve, reject };
      this.closingFlag = true;
      this.hold();
      try {
        this.member("close", "E5.1")();
      } catch (error) {
        reject(error as Error);
      }
    });
    return this.closePromise;
  }

  async ensureProvider(provider: string): Promise<void> {
    if (this.closingFlag) throw closed();
    return this.call((call) => this.member("ensureProvider", "E5.1")(provider, call));
  }

  providerAvailability(
    ...args: Parameters<EngineSurface["providerAvailability"]>
  ): ReturnType<EngineSurface["providerAvailability"]> {
    return JSON.parse(this.member("providerAvailability", "E5.1")(args[0]) as string) as ReturnType<
      EngineSurface["providerAvailability"]
    >;
  }

  capabilities(
    ...args: Parameters<EngineSurface["capabilities"]>
  ): ReturnType<EngineSurface["capabilities"]> {
    return JSON.parse(
      this.member("capabilities", "E5.1")(args[0], args[1]) as string,
    ) as ReturnType<EngineSurface["capabilities"]>;
  }

  bindOwnershipFence(...args: Parameters<EngineSurface["bindOwnershipFence"]>): void {
    this.ownershipFence = args[0];
  }

  bindCommandPolicy(...args: Parameters<EngineSurface["bindCommandPolicy"]>): void {
    this.commandPolicy = args[0] as (command: unknown, accept: () => unknown) => unknown;
  }

  bindHostInteractions(...args: Parameters<EngineSurface["bindHostInteractions"]>): void {
    this.hostInteractions = args[0] as (command: unknown) => unknown;
  }

  bindExternalTaskStop(...args: Parameters<EngineSurface["bindExternalTaskStop"]>): void {
    // Stored for E5.10, which routes a background hold's stop to its external owner here.
    this.externalTaskStop = { prefix: args[0], stop: args[1] };
  }

  bindDeletionPolicy(...args: Parameters<EngineSurface["bindDeletionPolicy"]>): void {
    this.deletionPolicy = args[0];
  }

  onLimitPolicy(listener: (id: ThreadId) => void): () => void {
    const id = this.nextPolicy++;
    const register = this.binding.onLimitPolicy;
    if (typeof register !== "function") throw incomplete("onLimitPolicy", "E5.1");
    register.call(this.binding, id, listener as (id: string) => void);
    return () => this.binding.dropLimitPolicy?.(id);
  }
  workload(..._args: Parameters<EngineSurface["workload"]>): ReturnType<EngineSurface["workload"]> {
    const raw = JSON.parse(this.member("workload", "E5.2")() as string) as Record<string, number>;
    return {
      activeSessions: raw["activeSessions"] ?? 0,
      queues: {
        "engine.frames": raw["engine.frames"] ?? 0,
        "engine.frameBytes": raw["engine.frameBytes"] ?? 0,
        "engine.queuedSends": raw["engine.queuedSends"] ?? 0,
      },
    };
  }
  rootAgent(
    ...args: Parameters<EngineSurface["rootAgent"]>
  ): ReturnType<EngineSurface["rootAgent"]> {
    const value = this.member("rootAgent", "E5.2")(args[0]) as string | null | undefined;
    return value ?? undefined;
  }
  liveThreadIds(
    ..._args: Parameters<EngineSurface["liveThreadIds"]>
  ): ReturnType<EngineSurface["liveThreadIds"]> {
    return this.member("liveThreadIds", "E5.2")() as ThreadId[];
  }
  override hasState(id: ThreadId): boolean {
    return this.member("hasState", "E5.3")(id) as boolean;
  }
  override retainsAttachment(id: ThreadId, hash: string): boolean {
    return queueRetains(this.binding, id, hash);
  }
  override queue(id: ThreadId): ReturnType<EngineSurface["queue"]> {
    return queueSnapshot(this.binding, id);
  }
  override queuePage(
    ...args: Parameters<EngineSurface["queuePage"]>
  ): ReturnType<EngineSurface["queuePage"]> {
    return queuePage(this.binding, args[0]);
  }
  override commandFailure(
    ...args: Parameters<EngineSurface["commandFailure"]>
  ): ReturnType<EngineSurface["commandFailure"]> {
    return commandFailure(this.binding, args[0]);
  }
  override commandExecution(
    ...args: Parameters<EngineSurface["commandExecution"]>
  ): ReturnType<EngineSurface["commandExecution"]> {
    return commandExecution(this.binding, args[0]) as ReturnType<EngineSurface["commandExecution"]>;
  }
  override prioritizeSubagentResult(
    ...args: Parameters<EngineSurface["prioritizeSubagentResult"]>
  ): ReturnType<EngineSurface["prioritizeSubagentResult"]> {
    prioritizeSubagentResult(this.binding, args[0], args[1]);
  }
  override inputFate(
    ...args: Parameters<EngineSurface["inputFate"]>
  ): ReturnType<EngineSurface["inputFate"]> {
    return inputFate(this.binding, args[0], args[1]);
  }
  override readRawBlob(id: string): Uint8Array | undefined {
    const bytes = this.member("readRawBlob", "E5.3")(id) as Uint8Array | null;
    return bytes ?? undefined;
  }
  /** The queue's deadline timer is armed again once the maintenance gate reopened. */
  override admissionReopened(): void {
    if (this.closingFlag) return;
    (this.member("admissionReopened", "E5.4d") as () => void)();
  }
  /** Readiness stays in the shell; the receipt's store work is Rust's. */
  override async prepareCommand(
    ...args: Parameters<EngineSurface["prepareCommand"]>
  ): ReturnType<EngineSurface["prepareCommand"]> {
    await this.readyPromise;
    // A resolveSilenceMs or preferences port is E5.6's; without one there is nothing to load.
    (this.binding.prepareCommand as ((value: string) => void) | undefined)?.(
      JSON.stringify(args[0]),
    );
  }
}

/** The one trusted cast of a value ace built (ADR 0125). */
export function nativeEngine(store: Store, options: EngineOptions = {}): NativeEngine {
  return new NativeEngine(store, options);
}

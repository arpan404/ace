// SPDX-License-Identifier: Apache-2.0
/**
 * The native engine facade (E5.1): every public member of `Engine` with the same timing, over
 * the addon. Members this item does not port fail at the call with
 * `NativeEngineIncomplete: <what> lands in E5.<n>` — synchronously for a sync member, as a
 * rejected promise for an async one — and never fall back to the TypeScript engine.
 */
import { appendFileSync } from "node:fs";
import { nativeHandle } from "@ace/provider-kit/sqlite";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import type { EngineOptions } from "../engine/engine-options.ts";
import type { Store } from "../store.ts";
import type { OpenFrame } from "../native-writer/transaction.ts";
import type { CommandHandler } from "../commands.ts";
import type { EngineSurface } from "../engine/index.ts";
import type { ThreadId } from "@ace/protocol";
import { personCommand } from "../engine/person-command.ts";
import { AdapterRegistry } from "../engine/registry.ts";
import { engineBindings, type EngineBindings, type PortHost } from "./ports.ts";
import { liveStorePort } from "./frames.ts";
import { openEngineData } from "./open.ts";

/** The store's transaction shell, for Rust-opened transactions. */
export interface NativeTransactionShell {
  open(): OpenFrame;
  close(
    frame: OpenFrame | number,
    result: { threw: false } | { threw: true; error: unknown },
  ): void;
  appendEvents(json: string): void;
  readonly transactionOpen: boolean;
}

/** The addon's engine handle: each member an item adds is optional until it lands. */
export interface NativeEngineHandle {
  pump?(): "rearm" | "done";
  startFlush?(call: number): void;
  close?(): void;
  settleCall?(call: number, error: string | null): void;
  ensureProvider?(provider: string, call: number): void;
  providerAvailability?(provider: string): string;
  capabilities?(provider: string, backend?: string): string;
  registryChanged?(json: string): void;
  timerFired?(key: number): void;
  settlePromise?(id: number, ok: boolean, message?: string): void;
  onLimitPolicy?(id: number, listener: (id: string) => void): void;
  dropLimitPolicy?(id: number): void;
  pumpStats?(): { turns: number; polls: number; longestPollUs: number; slowPolls: number };
  probeApply?(id: string, factsJson: string, now: number): void;
  probeApplyRolledBack?(id: string, factsJson: string, now: number): void;
  probePassThroughCollaborators?(): void;
  probeBudget?(): string;
  probeResident?(): number;
  probeHolds?(id: string): boolean;
  probeRollbackGeneration?(): number;
  probeQuarantine?(id: string): void;
  probeCandidatePages?(): string;
  hold?(): void;
  releaseHold?(): void;
  release?(): void;
  // E5.2's members: the actor, its frames and its flow.
  liveThreadIds?(): string[];
  workload?(): string;
  rootAgent?(threadId: string): string | undefined;
  actorFrame?(
    threadId: string,
    generation: number,
    handle: number,
    frame: unknown,
    isObject: boolean,
    certified: boolean,
    bytes: number | null,
    error: string | null,
    call: number,
  ): string;
  actorPaused?(threadId: string): boolean;
  actorWait?(threadId: string, call: number): void;
  attachTranslatorHelper?(helper: (thread: string, request: string) => string): void;
  attachLiveStore?(hooks: Record<string, unknown>): void;
  [member: string]: unknown;
}

interface DatabaseHandle {
  nativeEngine(bindings: EngineBindings, pump: () => void): NativeEngineHandle;
}

/** `NativeEngineIncomplete: <what> lands in E5.<n>`. */
export function incomplete(what: string, item: string): Error {
  return new Error(`NativeEngineIncomplete: ${what} lands in ${item}`);
}

function closed(): Error {
  return Object.assign(new Error("Engine closed"), { code: "ACE_ENGINE_CLOSED" });
}

let evidenceWritten = false;

function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_ENGINE_EVIDENCE;
  if (path === undefined) return;
  appendFileSync(path, `${process.pid} engine\n`);
  evidenceWritten = true;
}

type Settled = {
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
};

export class NativeEngine implements EngineSurface {
  /** The addon handle, for the test seam's probe hooks. */
  readonly binding: NativeEngineHandle;
  private readonly registry: AdapterRegistry;
  private readonly store: Store;
  readonly handler: CommandHandler;
  readonly internalHandler: CommandHandler;
  private readyPromise!: Promise<void>;
  private closePromise?: Promise<void>;
  private readySettled!: Settled;
  private closeSettled!: Settled;
  private readyFlag = false;
  private closingFlag = false;
  private readonly calls = new Map<number, Settled>();
  private nextCall = 1;
  private holders = 0;
  private stopObserving?: () => void;
  private stopLiveStore?: () => void;
  private ownershipFence?: Parameters<EngineSurface["bindOwnershipFence"]>[0];
  private commandPolicy?: (command: unknown, accept: () => unknown) => unknown;
  private hostInteractions?: (command: unknown) => unknown;
  private deletionPolicy?: (id: ThreadId, commandId: string) => void;
  private externalTaskStop?: { prefix: string; stop: (id: string, threadId: ThreadId) => void };
  private nextPolicy = 1;
  get guests(): EngineSurface["guests"] {
    throw incomplete("guests", "E5.7");
  }

  get hosts(): EngineSurface["hosts"] {
    throw incomplete("hosts", "E5.7");
  }

  get liveMove(): EngineSurface["liveMove"] {
    throw incomplete("liveMove", "E5.9");
  }

  turnOrigin = (
    ..._args: Parameters<EngineSurface["turnOrigin"]>
  ): ReturnType<EngineSurface["turnOrigin"]> => {
    throw incomplete("turnOrigin", "E5.5");
  };

  delegationsInFlight = (
    ..._args: Parameters<EngineSurface["delegationsInFlight"]>
  ): ReturnType<EngineSurface["delegationsInFlight"]> => {
    throw incomplete("delegationsInFlight", "E5.5");
  };

  constructor(store: Store, options: EngineOptions = {}) {
    recordEvidence();
    this.store = store;
    this.registry = options.registry ?? new AdapterRegistry();
    const shell = store.nativeTransactionShell;
    if (!shell) throw new Error("ACE_ENGINE needs ACE_STORE_WRITER=…,transactions");
    const database = nativeHandle(shell.db as unknown as object) as DatabaseHandle | undefined;
    if (!database)
      throw new Error(`ACE_ENGINE=native needs the engine addon at ${sessionsAddonPath()}`);
    let native: NativeEngineHandle | undefined;
    const host: PortHost = {
      settleCall: (call, error) => this.settle(call, error),
      rejectPending: () => this.rejectPending(),
      finishClose: () => this.finishClose(),
      resolveReady: (error) => this.finishReady(error),
      resolveClose: (error) => this.finishClosePromise(error),
      timerFired: (key) => native?.timerFired?.(key),
      settlePromise: (id, ok, message) => native?.settlePromise?.(id, ok, message),
    };
    // The opener: the TypeScript repository's schema setup, in today's order (E5.3 step 1).
    openEngineData(store, options, () => (options.clock ?? { now: Date.now }).now());
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
      store: this.store,
      shell,
      host,
    });
    const pump = () => {
      if (native?.pump?.() === "rearm") setImmediate(pump);
    };
    native = database.nativeEngine(bindings, pump);
    this.binding = native;
    // The engine's live writes go through the connection's one buffer (E5.2 step 16).
    this.stopLiveStore = liveStorePort(store, native);
    this.readyPromise = new Promise((resolve, reject) => {
      this.readySettled = { resolve, reject };
      this.hold();
    });
    const internal: CommandHandler = {
      handle: (command) => {
        if (this.closingFlag)
          return { commandId: command.id, ok: false, error: "daemon_shutting_down" };
        if (!this.readyFlag) return { commandId: command.id, ok: false, error: "engine_starting" };
        // E5.4: one synchronous binding call inside the receipt's transaction.
        const receipt = this.member("handle", "E5.4") as (value: unknown) => unknown;
        return receipt(command) as never;
      },
    };
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
  async retrySettled(
    ..._args: Parameters<EngineSurface["retrySettled"]>
  ): ReturnType<EngineSurface["retrySettled"]> {
    throw incomplete("retrySettled", "E5.10");
  }
  ownershipRefusal(
    ..._args: Parameters<EngineSurface["ownershipRefusal"]>
  ): ReturnType<EngineSurface["ownershipRefusal"]> {
    throw incomplete("ownershipRefusal", "E5.9");
  }
  supportsSteering(
    ..._args: Parameters<EngineSurface["supportsSteering"]>
  ): ReturnType<EngineSurface["supportsSteering"]> {
    throw incomplete("supportsSteering", "E5.5");
  }
  messageFacts(
    ..._args: Parameters<EngineSurface["messageFacts"]>
  ): ReturnType<EngineSurface["messageFacts"]> {
    throw incomplete("messageFacts", "E5.5");
  }
  prioritizeSubagentResult(
    ..._args: Parameters<EngineSurface["prioritizeSubagentResult"]>
  ): ReturnType<EngineSurface["prioritizeSubagentResult"]> {
    throw incomplete("prioritizeSubagentResult", "E5.4");
  }
  spawn(..._args: Parameters<EngineSurface["spawn"]>): ReturnType<EngineSurface["spawn"]> {
    throw incomplete("spawn", "E5.4");
  }
  admitCreation(
    ..._args: Parameters<EngineSurface["admitCreation"]>
  ): ReturnType<EngineSurface["admitCreation"]> {
    throw incomplete("admitCreation", "E5.4");
  }
  creationPending(
    ..._args: Parameters<EngineSurface["creationPending"]>
  ): ReturnType<EngineSurface["creationPending"]> {
    throw incomplete("creationPending", "E5.4");
  }
  access(..._args: Parameters<EngineSurface["access"]>): ReturnType<EngineSurface["access"]> {
    throw incomplete("access", "E5.7");
  }
  targetInstance(
    ..._args: Parameters<EngineSurface["targetInstance"]>
  ): ReturnType<EngineSurface["targetInstance"]> {
    throw incomplete("targetInstance", "E5.7");
  }
  childAccess(
    ..._args: Parameters<EngineSurface["childAccess"]>
  ): ReturnType<EngineSurface["childAccess"]> {
    throw incomplete("childAccess", "E5.7");
  }
  offeredModes(
    ..._args: Parameters<EngineSurface["offeredModes"]>
  ): ReturnType<EngineSurface["offeredModes"]> {
    throw incomplete("offeredModes", "E5.7");
  }
  childPermissionRefusal(
    ..._args: Parameters<EngineSurface["childPermissionRefusal"]>
  ): ReturnType<EngineSurface["childPermissionRefusal"]> {
    throw incomplete("childPermissionRefusal", "E5.7");
  }
  attachChild(
    ..._args: Parameters<EngineSurface["attachChild"]>
  ): ReturnType<EngineSurface["attachChild"]> {
    throw incomplete("attachChild", "E5.10");
  }
  updateChild(
    ..._args: Parameters<EngineSurface["updateChild"]>
  ): ReturnType<EngineSurface["updateChild"]> {
    throw incomplete("updateChild", "E5.10");
  }
  machineChild(
    ..._args: Parameters<EngineSurface["machineChild"]>
  ): ReturnType<EngineSurface["machineChild"]> {
    throw incomplete("machineChild", "E5.10");
  }
  transferHold(
    ..._args: Parameters<EngineSurface["transferHold"]>
  ): ReturnType<EngineSurface["transferHold"]> {
    throw incomplete("transferHold", "E5.10");
  }
  externalHold(
    ..._args: Parameters<EngineSurface["externalHold"]>
  ): ReturnType<EngineSurface["externalHold"]> {
    throw incomplete("externalHold", "E5.10");
  }
  delegationStarted(
    ..._args: Parameters<EngineSurface["delegationStarted"]>
  ): ReturnType<EngineSurface["delegationStarted"]> {
    throw incomplete("delegationStarted", "E5.10");
  }
  delegationSettled(
    ..._args: Parameters<EngineSurface["delegationSettled"]>
  ): ReturnType<EngineSurface["delegationSettled"]> {
    throw incomplete("delegationSettled", "E5.10");
  }
  machineHandoff(
    ..._args: Parameters<EngineSurface["machineHandoff"]>
  ): ReturnType<EngineSurface["machineHandoff"]> {
    throw incomplete("machineHandoff", "E5.9");
  }
  adoptMachineHandoff(
    ..._args: Parameters<EngineSurface["adoptMachineHandoff"]>
  ): ReturnType<EngineSurface["adoptMachineHandoff"]> {
    throw incomplete("adoptMachineHandoff", "E5.9");
  }
  workload(..._args: Parameters<EngineSurface["workload"]>): ReturnType<EngineSurface["workload"]> {
    throw incomplete("workload", "E5.2");
  }
  providerProcesses(
    ..._args: Parameters<EngineSurface["providerProcesses"]>
  ): ReturnType<EngineSurface["providerProcesses"]> {
    throw incomplete("providerProcesses", "E5.6");
  }
  backgroundPorts(
    ..._args: Parameters<EngineSurface["backgroundPorts"]>
  ): ReturnType<EngineSurface["backgroundPorts"]> {
    throw incomplete("backgroundPorts", "E5.6");
  }
  rootAgent(
    ..._args: Parameters<EngineSurface["rootAgent"]>
  ): ReturnType<EngineSurface["rootAgent"]> {
    throw incomplete("rootAgent", "E5.2");
  }
  activeRun(
    ..._args: Parameters<EngineSurface["activeRun"]>
  ): ReturnType<EngineSurface["activeRun"]> {
    throw incomplete("activeRun", "E5.5");
  }
  aceCaller(
    ..._args: Parameters<EngineSurface["aceCaller"]>
  ): ReturnType<EngineSurface["aceCaller"]> {
    throw incomplete("aceCaller", "E5.5");
  }
  withinAgent(
    ..._args: Parameters<EngineSurface["withinAgent"]>
  ): ReturnType<EngineSurface["withinAgent"]> {
    throw incomplete("withinAgent", "E5.5");
  }
  openHostApproval(
    ..._args: Parameters<EngineSurface["openHostApproval"]>
  ): ReturnType<EngineSurface["openHostApproval"]> {
    throw incomplete("openHostApproval", "E5.7");
  }
  hostError(
    ..._args: Parameters<EngineSurface["hostError"]>
  ): ReturnType<EngineSurface["hostError"]> {
    throw incomplete("hostError", "E5.7");
  }
  hostNotice(
    ..._args: Parameters<EngineSurface["hostNotice"]>
  ): ReturnType<EngineSurface["hostNotice"]> {
    throw incomplete("hostNotice", "E5.7");
  }
  resolveHostApproval(
    ..._args: Parameters<EngineSurface["resolveHostApproval"]>
  ): ReturnType<EngineSurface["resolveHostApproval"]> {
    throw incomplete("resolveHostApproval", "E5.7");
  }
  closeHostGate(
    ..._args: Parameters<EngineSurface["closeHostGate"]>
  ): ReturnType<EngineSurface["closeHostGate"]> {
    throw incomplete("closeHostGate", "E5.7");
  }
  discardRecovery(
    ..._args: Parameters<EngineSurface["discardRecovery"]>
  ): ReturnType<EngineSurface["discardRecovery"]> {
    throw incomplete("discardRecovery", "E5.8");
  }
  cancelRecovery(
    ..._args: Parameters<EngineSurface["cancelRecovery"]>
  ): ReturnType<EngineSurface["cancelRecovery"]> {
    throw incomplete("cancelRecovery", "E5.8");
  }
  captureContinuation(
    ..._args: Parameters<EngineSurface["captureContinuation"]>
  ): ReturnType<EngineSurface["captureContinuation"]> {
    throw incomplete("captureContinuation", "E5.8");
  }
  cancelDelegatedInputs(
    ..._args: Parameters<EngineSurface["cancelDelegatedInputs"]>
  ): ReturnType<EngineSurface["cancelDelegatedInputs"]> {
    throw incomplete("cancelDelegatedInputs", "E5.4");
  }
  async changeWorkspace(
    ..._args: Parameters<EngineSurface["changeWorkspace"]>
  ): ReturnType<EngineSurface["changeWorkspace"]> {
    throw incomplete("changeWorkspace", "E5.9");
  }
  async reconcileThread(
    ..._args: Parameters<EngineSurface["reconcileThread"]>
  ): ReturnType<EngineSurface["reconcileThread"]> {
    throw incomplete("reconcileThread", "E5.10");
  }
  async reconcileOwn(
    ..._args: Parameters<EngineSurface["reconcileOwn"]>
  ): ReturnType<EngineSurface["reconcileOwn"]> {
    throw incomplete("reconcileOwn", "E5.10");
  }
  hasSession(
    ..._args: Parameters<EngineSurface["hasSession"]>
  ): ReturnType<EngineSurface["hasSession"]> {
    throw incomplete("hasSession", "E5.6");
  }
  hasState(id: ThreadId): boolean {
    return this.member("hasState", "E5.3")(id) as boolean;
  }
  cleanupThreads(
    ..._args: Parameters<EngineSurface["cleanupThreads"]>
  ): ReturnType<EngineSurface["cleanupThreads"]> {
    throw incomplete("cleanupThreads", "E5.10");
  }
  liveWork(..._args: Parameters<EngineSurface["liveWork"]>): ReturnType<EngineSurface["liveWork"]> {
    throw incomplete("liveWork", "E5.10");
  }
  runsProviderWork(
    ..._args: Parameters<EngineSurface["runsProviderWork"]>
  ): ReturnType<EngineSurface["runsProviderWork"]> {
    throw incomplete("runsProviderWork", "E5.10");
  }
  hasUnfinishedWork(
    ..._args: Parameters<EngineSurface["hasUnfinishedWork"]>
  ): ReturnType<EngineSurface["hasUnfinishedWork"]> {
    throw incomplete("hasUnfinishedWork", "E5.10");
  }
  async stopForDeletion(
    ..._args: Parameters<EngineSurface["stopForDeletion"]>
  ): ReturnType<EngineSurface["stopForDeletion"]> {
    throw incomplete("stopForDeletion", "E5.10");
  }
  async cleanupSession(
    ..._args: Parameters<EngineSurface["cleanupSession"]>
  ): ReturnType<EngineSurface["cleanupSession"]> {
    throw incomplete("cleanupSession", "E5.10");
  }
  async stopForCancellation(
    ..._args: Parameters<EngineSurface["stopForCancellation"]>
  ): ReturnType<EngineSurface["stopForCancellation"]> {
    throw incomplete("stopForCancellation", "E5.10");
  }
  forgetPurged(
    ..._args: Parameters<EngineSurface["forgetPurged"]>
  ): ReturnType<EngineSurface["forgetPurged"]> {
    throw incomplete("forgetPurged", "E5.10");
  }
  prepareDeletion(
    ..._args: Parameters<EngineSurface["prepareDeletion"]>
  ): ReturnType<EngineSurface["prepareDeletion"]> {
    throw incomplete("prepareDeletion", "E5.10");
  }
  setSilenceMs(
    ..._args: Parameters<EngineSurface["setSilenceMs"]>
  ): ReturnType<EngineSurface["setSilenceMs"]> {
    throw incomplete("setSilenceMs", "E5.6");
  }
  clearWorkspaceSilenceMs(
    ..._args: Parameters<EngineSurface["clearWorkspaceSilenceMs"]>
  ): ReturnType<EngineSurface["clearWorkspaceSilenceMs"]> {
    throw incomplete("clearWorkspaceSilenceMs", "E5.6");
  }
  liveThreadIds(
    ..._args: Parameters<EngineSurface["liveThreadIds"]>
  ): ReturnType<EngineSurface["liveThreadIds"]> {
    throw incomplete("liveThreadIds", "E5.2");
  }
  async continueImported(
    ..._args: Parameters<EngineSurface["continueImported"]>
  ): ReturnType<EngineSurface["continueImported"]> {
    throw incomplete("continueImported", "E5.8");
  }
  sessionMetadata(
    ..._args: Parameters<EngineSurface["sessionMetadata"]>
  ): ReturnType<EngineSurface["sessionMetadata"]> {
    throw incomplete("sessionMetadata", "E5.6");
  }
  commandFailure(
    ..._args: Parameters<EngineSurface["commandFailure"]>
  ): ReturnType<EngineSurface["commandFailure"]> {
    throw incomplete("commandFailure", "E5.4");
  }
  commandExecution(
    ..._args: Parameters<EngineSurface["commandExecution"]>
  ): ReturnType<EngineSurface["commandExecution"]> {
    throw incomplete("commandExecution", "E5.4");
  }
  queuePage(
    ..._args: Parameters<EngineSurface["queuePage"]>
  ): ReturnType<EngineSurface["queuePage"]> {
    throw incomplete("queuePage", "E5.4");
  }
  queue(..._args: Parameters<EngineSurface["queue"]>): ReturnType<EngineSurface["queue"]> {
    throw incomplete("queue", "E5.4");
  }
  inputFate(
    ..._args: Parameters<EngineSurface["inputFate"]>
  ): ReturnType<EngineSurface["inputFate"]> {
    throw incomplete("inputFate", "E5.4");
  }
  retainsAttachment(id: ThreadId, hash: string): boolean {
    return this.member("retainsAttachment", "E5.3")(id, hash) as boolean;
  }
  readRawBlob(id: string): Uint8Array | undefined {
    const bytes = this.member("readRawBlob", "E5.3")(id) as Uint8Array | null;
    return bytes ?? undefined;
  }
  async prepareCommand(
    ..._args: Parameters<EngineSurface["prepareCommand"]>
  ): ReturnType<EngineSurface["prepareCommand"]> {
    throw incomplete("prepareCommand", "E5.4");
  }
  admissionReopened(
    ..._args: Parameters<EngineSurface["admissionReopened"]>
  ): ReturnType<EngineSurface["admissionReopened"]> {
    throw incomplete("admissionReopened", "E5.4");
  }
  accountRecovered(
    ..._args: Parameters<EngineSurface["accountRecovered"]>
  ): ReturnType<EngineSurface["accountRecovered"]> {
    throw incomplete("accountRecovered", "E5.8");
  }
  resuming(..._args: Parameters<EngineSurface["resuming"]>): ReturnType<EngineSurface["resuming"]> {
    throw incomplete("resuming", "E5.8");
  }
  endedOnLimit(
    ..._args: Parameters<EngineSurface["endedOnLimit"]>
  ): ReturnType<EngineSurface["endedOnLimit"]> {
    throw incomplete("endedOnLimit", "E5.8");
  }
  treeActive(
    ..._args: Parameters<EngineSurface["treeActive"]>
  ): ReturnType<EngineSurface["treeActive"]> {
    throw incomplete("treeActive", "E5.8");
  }
  limitContinues(
    ..._args: Parameters<EngineSurface["limitContinues"]>
  ): ReturnType<EngineSurface["limitContinues"]> {
    throw incomplete("limitContinues", "E5.8");
  }
  heldInterrupted(
    ..._args: Parameters<EngineSurface["heldInterrupted"]>
  ): ReturnType<EngineSurface["heldInterrupted"]> {
    throw incomplete("heldInterrupted", "E5.8");
  }
  limitsMatter(
    ..._args: Parameters<EngineSurface["limitsMatter"]>
  ): ReturnType<EngineSurface["limitsMatter"]> {
    throw incomplete("limitsMatter", "E5.8");
  }
}

/** The one trusted cast of a value ace built (ADR 0125). */
export function nativeEngine(store: Store, options: EngineOptions = {}): NativeEngine {
  return new NativeEngine(store, options);
}

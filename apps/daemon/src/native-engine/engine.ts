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
import type { ThreadId } from "@ace/protocol";
import { personCommand } from "../engine/person-command.ts";
import { AdapterRegistry } from "../engine/registry.ts";
import { engineBindings, type EngineBindings, type PortHost } from "./ports.ts";

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

/** A facade object whose every member lands in `item`. */
function notPortedObject(item: string): unknown {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw incomplete("this facade object", item);
      },
    },
  );
}

/** The item each unported member's behaviour lands in (the brief's table). */
const ITEMS: Readonly<Record<string, string>> = {
  retrySettled: "E5.10",
  ownershipRefusal: "E5.9",
  supportsSteering: "E5.5",
  messageFacts: "E5.5",
  prioritizeSubagentResult: "E5.4",
  spawn: "E5.4",
  admitCreation: "E5.4",
  creationPending: "E5.4",
  access: "E5.7",
  targetInstance: "E5.7",
  childAccess: "E5.7",
  offeredModes: "E5.7",
  childPermissionRefusal: "E5.7",
  attachChild: "E5.10",
  updateChild: "E5.10",
  machineChild: "E5.10",
  transferHold: "E5.10",
  externalHold: "E5.10",
  delegationStarted: "E5.10",
  delegationSettled: "E5.10",
  machineHandoff: "E5.9",
  adoptMachineHandoff: "E5.9",
  workload: "E5.2",
  providerProcesses: "E5.6",
  backgroundPorts: "E5.6",
  rootAgent: "E5.2",
  activeRun: "E5.5",
  aceCaller: "E5.5",
  withinAgent: "E5.5",
  openHostApproval: "E5.7",
  hostError: "E5.7",
  hostNotice: "E5.7",
  resolveHostApproval: "E5.7",
  closeHostGate: "E5.7",
  discardRecovery: "E5.8",
  cancelRecovery: "E5.8",
  captureContinuation: "E5.8",
  cancelDelegatedInputs: "E5.4",
  changeWorkspace: "E5.9",
  reconcileThread: "E5.10",
  reconcileOwn: "E5.10",
  hasSession: "E5.6",
  hasState: "E5.3",
  cleanupThreads: "E5.10",
  liveWork: "E5.10",
  runsProviderWork: "E5.10",
  hasUnfinishedWork: "E5.10",
  stopForDeletion: "E5.10",
  cleanupSession: "E5.10",
  stopForCancellation: "E5.10",
  forgetPurged: "E5.10",
  prepareDeletion: "E5.10",
  setSilenceMs: "E5.6",
  clearWorkspaceSilenceMs: "E5.6",
  liveThreadIds: "E5.2",
  continueImported: "E5.8",
  sessionMetadata: "E5.6",
  commandFailure: "E5.4",
  commandExecution: "E5.4",
  queuePage: "E5.4",
  queue: "E5.4",
  inputFate: "E5.4",
  retainsAttachment: "E5.3",
  readRawBlob: "E5.3",
  prepareCommand: "E5.4",
  admissionReopened: "E5.4",
  accountRecovered: "E5.8",
  resuming: "E5.8",
  endedOnLimit: "E5.8",
  treeActive: "E5.8",
  limitContinues: "E5.8",
  heldInterrupted: "E5.8",
  limitsMatter: "E5.8",
};

const ASYNC = new Set([
  "retrySettled",
  "changeWorkspace",
  "reconcileThread",
  "reconcileOwn",
  "stopForDeletion",
  "cleanupSession",
  "stopForCancellation",
  "continueImported",
  "prepareCommand",
]);

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

export class NativeEngine {
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
  private nextCall = 1;
  private holders = 0;
  private keepAlive?: ReturnType<typeof setInterval> | undefined;
  private stopObserving?: () => void;
  private ownershipFence?: (id: ThreadId) => string | undefined;
  private commandPolicy?: (command: unknown, accept: () => unknown) => unknown;
  private hostInteractions?: (command: unknown) => unknown;
  private deletionPolicy?: (id: ThreadId, commandId: string) => void;
  private externalTaskStop?: { prefix: string; stop: (id: string, threadId: ThreadId) => void };
  private nextPolicy = 1;
  readonly guests: unknown;
  readonly hosts: unknown;
  readonly liveMove: unknown;
  turnOrigin: (...args: never[]) => unknown;
  delegationsInFlight: (...args: never[]) => unknown;

  constructor(store: Store, options: EngineOptions = {}) {
    recordEvidence();
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
    let entries = "[]";
    this.stopObserving = this.registry.observe((list) => {
      entries = JSON.stringify(
        list.map((entry) => ({
          provider: entry.provider,
          backend: entry.backend ?? null,
          adapter: 0,
          capabilities: entry.capabilities,
          discovery: entry.discovery,
        })),
      );
      native?.registryChanged?.(entries);
    });
    const bindings = engineBindings({ options, registryJson: entries, store: shell, host });
    const pump = () => {
      if (native?.pump?.() === "rearm") setImmediate(pump);
    };
    native = database.nativeEngine(bindings, pump);
    this.binding = native;
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
    this.guests = notPortedObject("E5.7");
    this.hosts = notPortedObject("E5.7");
    this.liveMove = notPortedObject("E5.9");
    for (const name of Object.keys(ITEMS)) {
      const target = this as unknown as Record<string, unknown>;
      if (ASYNC.has(name))
        target[name] = async () => {
          throw incomplete(name, ITEMS[name] ?? "E5.1");
        };
      else
        target[name] = () => {
          throw incomplete(name, ITEMS[name] ?? "E5.1");
        };
    }
    this.turnOrigin = () => {
      throw incomplete("turnOrigin", "E5.5");
    };
    this.delegationsInFlight = () => {
      throw incomplete("delegationsInFlight", "E5.5");
    };
  }

  /** The binding member, or the item that lands it. */
  private member(name: string, item: string): (...args: unknown[]) => unknown {
    const member = this.binding[name];
    if (typeof member !== "function") throw incomplete(name, item);
    return member.bind(this.binding) as (...args: unknown[]) => unknown;
  }

  private hold(): void {
    this.holders += 1;
    if (this.holders === 1) this.keepAlive = setInterval(() => {}, 1 << 28);
  }

  private releaseHolder(): void {
    if (this.holders === 0) return;
    this.holders -= 1;
    if (this.holders === 0 && this.keepAlive !== undefined) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
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
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  flush(): Promise<void> {
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
    return this.call((call) => this.member("ensureProvider", "E5.1")(provider, call));
  }

  providerAvailability(provider: string): { installed: boolean; auth: string } {
    return JSON.parse(this.member("providerAvailability", "E5.1")(provider) as string) as {
      installed: boolean;
      auth: string;
    };
  }

  capabilities(provider: string, backend?: string): unknown {
    return JSON.parse(this.member("capabilities", "E5.1")(provider, backend) as string);
  }

  bindOwnershipFence(fence: (id: ThreadId) => string | undefined): void {
    this.ownershipFence = fence;
  }

  bindCommandPolicy(policy: (command: unknown, accept: () => unknown) => unknown): void {
    this.commandPolicy = policy;
  }

  bindHostInteractions(handler: (command: unknown) => unknown): void {
    this.hostInteractions = handler;
  }

  bindExternalTaskStop(prefix: string, stop: (id: string, threadId: ThreadId) => void): void {
    // Stored for E5.10, which routes a background hold's stop to its external owner here.
    this.externalTaskStop = { prefix, stop };
  }

  bindDeletionPolicy(policy: (id: ThreadId, commandId: string) => void): void {
    this.deletionPolicy = policy;
  }

  onLimitPolicy(listener: (id: ThreadId) => void): () => void {
    const id = this.nextPolicy++;
    const register = this.binding.onLimitPolicy;
    if (typeof register !== "function") throw incomplete("onLimitPolicy", "E5.1");
    register.call(this.binding, id, listener as (id: string) => void);
    return () => this.binding.dropLimitPolicy?.(id);
  }
}

/** The one trusted cast of a value ace built (ADR 0125). */
export function nativeEngine(store: Store, options: EngineOptions = {}): NativeEngine {
  return new NativeEngine(store, options);
}

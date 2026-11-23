// SPDX-License-Identifier: Apache-2.0
/**
 * The native core facade (E4): `@ace/core`'s reducer over the napi addon
 * (`ACE_CORE=native`) and over WebAssembly (`ACE_CORE=wasm`), behind the
 * same `ThreadState` shape tests read today.
 *
 * `createThreadState` returns an object holding a native `CoreThread`;
 * `apply` and `FactBatch` fold on it and return events. The native state is
 * not copied back after every fold: the `ThreadState` fields are accessors
 * that re-read the handle's snapshot the next time the field is looked at,
 * so a fold costs one crossing and TypeScript still sees the same shape
 * (same field names, optional fields absent, never `null`).
 *
 * Nothing here touches the host until a backend is actually in use: the addon
 * path and the wasm loaders are resolved inside the calls that need them, so
 * importing this module works in a browser and with `ACE_CORE` switched off.
 */

import type { AgentStatus, EventPayload, ThreadId, ThreadStatus } from "@ace/protocol";
import { coreBackend, useCoreBackend } from "./backend.ts";
import type { ApplyContext, CoreConfig, ThreadState } from "./state.ts";
import type { Fact, RootAgentInit } from "./facts.ts";
import { diagnosticData } from "./diagnostics.ts";
import { isFactData } from "./fact-data.ts";
import {
  applyResult,
  type CoreThreadHandle,
  handleFor,
  invalidate,
  lazyThreadState,
} from "./native-state.ts";

interface DeadlineIndexHandle {
  rebuild(stateJson: string): void;
  signal(agent: string | undefined, at: number, silenceMs: number): void;
  next(providerDeadline?: number): number | undefined;
}

interface NativeAddon {
  CoreThreadNative: {
    new (threadId: string, configJson: string, rootJson?: string): CoreThreadHandle;
    fromState(stateJson: string): CoreThreadHandle;
  };
  DeadlineIndexNative: new (stateJson: string) => DeadlineIndexHandle;
  coreDeriveAgentStatus(stateJson: string, key: string, now: number): string;
  coreDeriveThreadStatus(stateJson: string): string;
  coreNextDeadline(stateJson: string, providerDeadline?: number): number | undefined;
  coreCompletionRelevant(stateJson: string, key: string): boolean;
  coreIsActionableInteraction(interactionJson: string, ownerJson?: string): boolean;
}

interface WasmExports {
  core_create_thread(threadId: string, configJson: string, rootJson?: string): string;
  core_apply(
    stateJson: string,
    factJson: string,
    now: number,
    nextId: (kind: string) => string,
    resolvingJson?: string,
  ): string;
  core_reject(
    stateJson: string,
    dataJson: string,
    reason: string,
    now: number,
    nextId: (kind: string) => string,
  ): string;
  core_derive_agent_status(stateJson: string, key: string, now: number): string;
  core_derive_thread_status(stateJson: string): string;
  core_next_deadline(stateJson: string, providerDeadline?: number): number | undefined;
  core_completion_relevant(stateJson: string, key: string): boolean;
  core_is_actionable_interaction(interactionJson: string, ownerJson?: string): boolean;
  WasmDeadlineIndex: new (stateJson: string) => {
    rebuild(stateJson: string): void;
    signal(agent: string | undefined, at: number, silenceMs: number): void;
    next(providerDeadline?: number): number | undefined;
  };
  WasmBatch: new (
    stateJson: string,
    deadlineJson?: string,
  ) => {
    apply(
      factJson: string,
      now: number,
      nextId: (kind: string) => string,
      resolvingJson?: string,
    ): string;
    reject(dataJson: string, reason: string, now: number, nextId: (kind: string) => string): string;
    flush(): string;
  };
}

/** The addon's file name for this platform. Only read where the addon is opened. */
function library(): string {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform ?? "";
  if (platform === "win32") return "ace_daemon_node.dll";
  if (platform === "darwin") return "libace_daemon_node.dylib";
  return "libace_daemon_node.so";
}

/** The Node build of the wasm core, beside the crate it is built from. */
const WASM_NODE = "../../../native/daemon/wasm-pkg-nodejs/ace_core_wasm.js";

function addonPath(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const explicit = env?.ACE_CORE_ADDON ?? env?.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return new URL(`../../../native/daemon/target/release/${library()}`, import.meta.url).pathname;
}

let loaded: NativeAddon | undefined;
function addon(): NativeAddon {
  if (loaded) return loaded;
  if (coreBackend() !== "native") throw new Error("native core is off");
  const path = addonPath();
  const module = { exports: {} as Record<string, unknown> };
  (process as unknown as { dlopen: (mod: unknown, path: string) => void }).dlopen(module, path);
  loaded = module.exports as unknown as NativeAddon;
  return loaded;
}

const isNode =
  typeof process !== "undefined" &&
  (process as { versions?: { node?: string } }).versions?.node !== undefined;

/** Synchronous `require` on Node (Bun and Node 26 provide `import.meta.require`). */
function nodeRequire(id: string): unknown {
  const viaMeta = (import.meta as unknown as { require?: (id: string) => unknown }).require;
  if (typeof viaMeta === "function") return viaMeta(id);
  // Vitest workers lack `import.meta.require`; use Node's synchronous
  // built-in loader instead (resolves relative to this file).
  const proc = globalThis as unknown as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const getBuiltin = proc.process?.getBuiltinModule;
  if (typeof getBuiltin === "function") {
    const mod = getBuiltin.call(proc.process, "module") as {
      createRequire: (url: string) => (id: string) => unknown;
    };
    return mod.createRequire(import.meta.url)(id);
  }
  throw new Error(`wasm core needs its nodejs build at ${id}`);
}

let wasmNode: WasmExports | undefined;
function wasm(): WasmExports {
  if (wasmNode) return wasmNode;
  if (coreBackend() !== "wasm") throw new Error("wasm core is off");
  wasmNode = nodeRequire(WASM_NODE) as WasmExports;
  return wasmNode;
}

/** Boot the browser's core: the fake daemon runs on wasm, chosen here, never by environment. */
export async function startFakeCore(): Promise<void> {
  useCoreBackend("wasm");
  await ensureNativeCoreReady();
}

let wasmBrowser: WasmExports | undefined;
let wasmBrowserReady: Promise<WasmExports> | undefined;
/** Instantiate the browser's wasm core; a caller that folds must await this first. */
export function ensureNativeCoreReady(): Promise<void> {
  if (coreBackend() !== "wasm" || isNode) return Promise.resolve();
  wasmBrowserReady ??= (async () => {
    const pkg = (await import("../../../native/daemon/wasm-pkg/ace_core_wasm.js")) as {
      default: (bytes: ArrayBuffer) => Promise<unknown>;
    } & WasmExports;
    const response = await fetch(
      new URL("../../../native/daemon/wasm-pkg/ace_core_wasm_bg.wasm", import.meta.url),
    );
    await pkg.default(await response.arrayBuffer());
    wasmBrowser = pkg as unknown as WasmExports;
    return wasmBrowser;
  })();
  return wasmBrowserReady.then(() => undefined);
}

function wasmAny(): WasmExports {
  if (isNode) return wasm();
  if (!wasmBrowser) throw new Error("wasm core is still loading; await ensureNativeCoreReady()");
  return wasmBrowser;
}

/** The id kinds core allocates. */
type IdKind = Parameters<ApplyContext["ids"]["next"]>[0];

/** A restored state folds from its own JSON behind a fresh handle. */
function openThread(stateJson: string): CoreThreadHandle {
  return addon().CoreThreadNative.fromState(stateJson);
}

function idsNext(ctx: ApplyContext): (kind: string) => string {
  return (kind: string) => {
    // Core asked for the id, so the kind is one of its own.
    const id = ctx.ids.next(kind as IdKind);
    if (id === undefined) throw new Error("ids.next must return a string");
    return id;
  };
}

/** The engine's answer RPCs in flight: a turn that ends now keeps their interactions open. */
function resolvingJson(ctx: ApplyContext): string | undefined {
  if (ctx.resolvingInteractions === undefined) return undefined;
  return JSON.stringify([...ctx.resolvingInteractions]);
}

/** The fact as JSON, after the preflight the TypeScript fold runs on the value itself. */
function factJson(fact: unknown): string {
  const json = JSON.stringify(fact);
  // `undefined` has no JSON text; the core reads it as the non-object fact it is.
  return json === undefined ? "null" : json;
}

/**
 * A fact JSON cannot carry (a `bigint`, a function, a cycle, a non-finite number) is rejected by
 * the same rule and with the same described data the TypeScript uses, so the notice matches.
 */
function rejectNonJson(state: ThreadState, fact: unknown, ctx: ApplyContext): EventPayload[] {
  const data = JSON.stringify(diagnosticData(fact)) ?? "null";
  const reason = "adapter facts must contain JSON data";
  if (coreBackend() === "native")
    return fold(state, () =>
      handleFor(state, openThread).reject(data, reason, ctx.now, idsNext(ctx)),
    );
  return applyResult(
    state,
    wasmAny().core_reject(JSON.stringify(state), data, reason, ctx.now, idsNext(ctx)),
  );
}

/**
 * Fold one fact through `call` and read the answer. A rollback the core had already begun when
 * an id callback failed leaves the handle's state changed, so the view is invalidated either
 * way: the handle stays the one source of truth.
 */
function fold(state: ThreadState, call: () => string): EventPayload[] {
  try {
    return applyResult(state, call());
  } catch (error) {
    invalidate(state);
    throw error;
  }
}

/** Create a thread state holding a native `CoreThread`. */
export function createThreadState(init: {
  threadId: ThreadId;
  rootAgent?: RootAgentInit;
  config: CoreConfig;
  /** Seed plain state before it becomes the core's (an imported historical thread's root). */
  seed?: (state: ThreadState) => void;
}): ThreadState {
  const backend = coreBackend();
  if (backend === "native") {
    const handle = new (addon().CoreThreadNative)(
      String(init.threadId),
      JSON.stringify(init.config),
      init.rootAgent === undefined ? undefined : JSON.stringify(init.rootAgent),
    );
    if (init.seed === undefined) return lazyThreadState(handle);
    const plain = JSON.parse(handle.snapshot()) as ThreadState;
    init.seed(plain);
    handle.adopt(JSON.stringify(plain));
    return lazyThreadState(handle);
  }
  if (backend === "wasm") {
    const result = wasmAny().core_create_thread(
      String(init.threadId),
      JSON.stringify(init.config),
      init.rootAgent === undefined ? undefined : JSON.stringify(init.rootAgent),
    );
    const state = JSON.parse(result) as ThreadState;
    init.seed?.(state);
    return state;
  }
  throw new Error("native core is off");
}

/** Fold one adapter fact and recompute statuses. */
export function apply(state: ThreadState, fact: unknown, ctx: ApplyContext): EventPayload[] {
  const backend = coreBackend();
  // The fold's preflight reads the value itself: a fact JSON cannot carry must be rejected, not
  // stringified away (`1n` into a valid update, a function-valued field into nothing).
  if (!isFactData(fact)) return rejectNonJson(state, fact, ctx);
  const json = factJson(fact);
  if (backend === "native")
    return fold(state, () =>
      handleFor(state, openThread).apply(json, ctx.now, idsNext(ctx), resolvingJson(ctx)),
    );
  if (backend === "wasm") {
    return applyResult(
      state,
      wasmAny().core_apply(JSON.stringify(state), json, ctx.now, idsNext(ctx), resolvingJson(ctx)),
    );
  }
  throw new Error("native core is off");
}

/** A provider frame commits atomically; see `FactBatch` in `reduce.ts`. */
export class FactBatch {
  private readonly state: ThreadState;
  private readonly backend: string;
  /** The native batch handle; each wrapper owns its own, as the TypeScript's does. */
  private batchId: number;
  /** The deadline this wrapper opened with, to open another batch after a flush. */
  private readonly deadlineJson: string | undefined;
  /** Whether the native handle retired this batch (a flush happened). */
  private closed = false;
  /** The stable-signal eligibility the TypeScript batch keeps, mirrored across a flush. */
  private preserveSignals: boolean;
  private readonly wasmBatch: InstanceType<WasmExports["WasmBatch"]> | undefined;
  constructor(state: ThreadState, stableSignals?: { deadline: number | undefined }) {
    this.state = state;
    const backend = coreBackend();
    this.backend = backend;
    this.preserveSignals = stableSignals !== undefined;
    if (backend === "typescript") throw new Error("native FactBatch is off");
    const deadlineJson =
      stableSignals === undefined ? undefined : JSON.stringify(stableSignals.deadline ?? null);
    this.deadlineJson = deadlineJson;
    if (backend === "native") {
      this.batchId = handleFor(state, openThread).batchBegin(deadlineJson);
      this.wasmBatch = undefined;
    } else {
      this.batchId = 0;
      this.wasmBatch = new (wasmAny().WasmBatch)(JSON.stringify(state), deadlineJson);
    }
  }
  apply(fact: Fact, ctx: ApplyContext): EventPayload[] {
    if (this.closed) this.reopen();
    if (!isFactData(fact)) return this.rejectNonJson(fact, ctx);
    const events = this.applyFact(fact, ctx);
    // Any non-signal control fact invalidates the cached eligibility window, as in `reduce.ts`.
    if (
      (fact.type !== "signal" && fact.type !== "item.delta") ||
      events.some((event) => event.type !== "item.delta")
    )
      this.preserveSignals = false;
    return events;
  }
  private applyFact(fact: Fact, ctx: ApplyContext): EventPayload[] {
    if (this.backend === "wasm") {
      const batch = this.wasmBatch;
      if (!batch) throw new Error("wasm batch is off");
      return applyResult(
        this.state,
        batch.apply(factJson(fact), ctx.now, idsNext(ctx), resolvingJson(ctx)),
      );
    }
    return fold(this.state, () =>
      handleFor(this.state, openThread).batchApply(
        this.batchId,
        factJson(fact),
        ctx.now,
        idsNext(ctx),
        resolvingJson(ctx),
      ),
    );
  }
  flush(): EventPayload[] {
    // A batch's flush is idempotent in the TypeScript fold: nothing pending means nothing to
    // say. The native handle retires the batch on its first flush.
    if (this.closed) return [];
    if (this.backend === "wasm") {
      const batch = this.wasmBatch;
      if (!batch) throw new Error("wasm batch is off");
      return applyResult(this.state, batch.flush());
    }
    const events = fold(this.state, () =>
      handleFor(this.state, openThread).batchFlush(this.batchId),
    );
    this.closed = true;
    return events;
  }
  /** A rejection inside a batch is that batch's own, so its flush order stays right. */
  private rejectNonJson(fact: unknown, ctx: ApplyContext): EventPayload[] {
    const data = JSON.stringify(diagnosticData(fact)) ?? "null";
    const reason = "adapter facts must contain JSON data";
    if (this.backend === "wasm") {
      const batch = this.wasmBatch;
      if (!batch) throw new Error("wasm batch is off");
      return applyResult(this.state, batch.reject(data, reason, ctx.now, idsNext(ctx)));
    }
    return fold(this.state, () =>
      handleFor(this.state, openThread).batchReject(
        this.batchId,
        data,
        reason,
        ctx.now,
        idsNext(ctx),
      ),
    );
  }
  /** Open a fresh native batch with this wrapper's deadline after a flush retired the last. */
  private reopen(): void {
    if (this.backend === "wasm") return;
    // Under the same id and with the same stable-signal eligibility the batch had.
    this.batchId = handleFor(this.state, openThread).batchBegin(
      this.deadlineJson,
      this.batchId,
      this.preserveSignals,
    );
    this.closed = false;
  }
}

/** Derive one agent's status for the current fact, descendants first. */
export function deriveAgentStatus(state: ThreadState, key: string, now: number): AgentStatus {
  const backend = coreBackend();
  if (backend === "native")
    return JSON.parse(
      addon().coreDeriveAgentStatus(JSON.stringify(state), key, now),
    ) as AgentStatus;
  return JSON.parse(
    wasmAny().core_derive_agent_status(JSON.stringify(state), key, now),
  ) as AgentStatus;
}

/** Derive one thread's status from its agents. */
export function deriveThreadStatus(state: ThreadState): ThreadStatus {
  const backend = coreBackend();
  if (backend === "native")
    return JSON.parse(addon().coreDeriveThreadStatus(JSON.stringify(state))) as ThreadStatus;
  return JSON.parse(wasmAny().core_derive_thread_status(JSON.stringify(state))) as ThreadStatus;
}

/** The earliest injected instant at which a tick can change a status. */
export function nextDeadline(state: ThreadState, providerDeadline?: number): number | undefined {
  const backend = coreBackend();
  if (backend === "native")
    return (
      (addon().coreNextDeadline(JSON.stringify(state), providerDeadline) as
        | number
        | null
        | undefined) ?? undefined
    );
  return wasmAny().core_next_deadline(JSON.stringify(state), providerDeadline);
}

/** Read completion evidence from an already-derived, persisted agent tree. */
export function completionRelevanceReader(state: ThreadState): (key: string) => boolean {
  return (key: string) => {
    const backend = coreBackend();
    const json = JSON.stringify(state);
    if (backend === "native") return addon().coreCompletionRelevant(json, key);
    return wasmAny().core_completion_relevant(json, key);
  };
}

/** The same human attention rule governs thread status and notification links. */
export function isActionableInteraction(
  interaction: { state: string; blocking: boolean },
  owner: { state: string } | undefined,
): boolean {
  const backend = coreBackend();
  const interactionJson = JSON.stringify(interaction);
  const ownerJson = owner === undefined ? undefined : JSON.stringify(owner);
  if (backend === "native") return addon().coreIsActionableInteraction(interactionJson, ownerJson);
  return wasmAny().core_is_actionable_interaction(interactionJson, ownerJson);
}

/** Candidate eligibility changes at structural facts. */
export class DeadlineIndex {
  private readonly handle: DeadlineIndexHandle | undefined;
  private readonly wasmHandle: InstanceType<WasmExports["WasmDeadlineIndex"]> | undefined;
  constructor(state: ThreadState) {
    const backend = coreBackend();
    if (backend === "native") {
      this.handle = new (addon().DeadlineIndexNative)(JSON.stringify(state));
      this.wasmHandle = undefined;
    } else if (backend === "wasm") {
      this.wasmHandle = new (wasmAny().WasmDeadlineIndex)(JSON.stringify(state));
      this.handle = undefined;
    } else {
      throw new Error("native core is off");
    }
  }
  rebuild(state: ThreadState): void {
    const json = JSON.stringify(state);
    if (this.handle) this.handle.rebuild(json);
    else this.wasmHandle?.rebuild(json);
  }
  signal(agent: string | undefined, at: number, silenceMs: number): void {
    if (this.handle) this.handle.signal(agent, at, silenceMs);
    else this.wasmHandle?.signal(agent, at, silenceMs);
  }
  next(providerDeadline?: number): number | undefined {
    if (this.handle)
      return (this.handle.next(providerDeadline) as number | null | undefined) ?? undefined;
    return this.wasmHandle?.next(providerDeadline);
  }
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The native core facade (E4): `@ace/core`'s reducer over the napi addon
 * (`ACE_CORE=native`) and over WebAssembly (`ACE_CORE=wasm`), behind the
 * same `ThreadState` shape tests read today.
 *
 * `createThreadState` returns an object holding a native `CoreThread`;
 * `apply` and `FactBatch` fold on it and return events; the `ThreadState`
 * fields are refreshed from the native state after each call, so tests
 * reading them see the same shape (same field names, optional fields
 * omitted, never `null`).
 */

import type { AgentStatus, EventPayload, ThreadId, ThreadStatus } from "@ace/protocol";
import { coreBackend } from "@ace/provider-kit/native-switches";
import type { ApplyContext, CoreConfig, RootAgentInit, ThreadState } from "./state.ts";
import type { Fact } from "./facts.ts";

interface CoreThreadHandle {
  apply(factJson: string, now: number, nextId: (kind: string) => string): string;
  batchBegin(deadlineJson: string | undefined): void;
  batchApply(factJson: string, now: number, nextId: (kind: string) => string): string;
  batchFlush(): string;
  snapshot(): string;
}

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
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

function addonPath(): string {
  const explicit = process.env.ACE_CORE_ADDON ?? process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return new URL(`../../../native/daemon/target/release/${library}`, import.meta.url).pathname;
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
  typeof process !== "undefined" && (process as { versions?: { node?: string } }).versions?.node !== undefined;

/** Synchronous `require` on Node (Bun and Node 26 provide `import.meta.require`). */
function nodeRequire(id: string): unknown {
  const viaMeta = (import.meta as unknown as { require?: (id: string) => unknown }).require;
  if (typeof viaMeta === "function") return viaMeta(id);
  throw new Error(`wasm core needs its nodejs build at ${id}`);
}

let wasmNode: WasmExports | undefined;
function wasm(): WasmExports {
  if (wasmNode) return wasmNode;
  if (coreBackend() !== "wasm") throw new Error("wasm core is off");
  wasmNode = nodeRequire("../../native/daemon/wasm-pkg-nodejs/ace_core_wasm.js") as WasmExports;
  return wasmNode;
}

let wasmBrowser: WasmExports | undefined;
let wasmBrowserReady: Promise<WasmExports> | undefined;
/** Resolve once the browser's wasm core is instantiated (fake-daemon startup awaits this). */
export function ensureNativeCoreReady(): Promise<void> {
  if (coreBackend() !== "wasm" || isNode) return Promise.resolve();
  wasmBrowserReady ??= (async () => {
    const pkg = (await import("../../native/daemon/wasm-pkg/ace_core_wasm.js")) as {
      default: (bytes: BufferSource) => Promise<unknown>;
    } & WasmExports;
    const response = await fetch(
      new URL("../../native/daemon/wasm-pkg/ace_core_wasm_bg.wasm", import.meta.url),
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

/** The native handle behind one `ThreadState`, keyed by object identity. */
const handles = new WeakMap<object, CoreThreadHandle>();

function handleFor(state: ThreadState): CoreThreadHandle {
  const known = handles.get(state);
  if (known) return known;
  // A restored snapshot or a clone: fold it natively from its current JSON.
  if (coreBackend() !== "native") throw new Error("native core is off");
  const handle = addon().CoreThreadNative.fromState(JSON.stringify(state));
  handles.set(state, handle);
  return handle;
}

/** Refresh the test-visible fields from the native state after each call. */
function refreshState(target: ThreadState, fresh: ThreadState): void {
  for (const key of Object.keys(target)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, fresh);
}

function idsNext(ctx: ApplyContext): (kind: string) => string {
  return (kind: string) => {
    const id = ctx.ids.next(kind);
    if (id === undefined) throw new Error("ids.next must return a string");
    return id;
  };
}

function applyResult(state: ThreadState, responseJson: string): EventPayload[] {
  const response = JSON.parse(responseJson) as { events: EventPayload[]; state: ThreadState };
  refreshState(state, response.state);
  return response.events;
}

/** Create a thread state holding a native `CoreThread`. */
export function createThreadState(init: {
  threadId: ThreadId;
  rootAgent?: RootAgentInit;
  config: CoreConfig;
}): ThreadState {
  const backend = coreBackend();
  if (backend === "native") {
    const handle = new (addon().CoreThreadNative)(
      String(init.threadId),
      JSON.stringify(init.config),
      init.rootAgent === undefined ? undefined : JSON.stringify(init.rootAgent),
    );
    const state = JSON.parse(handle.snapshot()) as ThreadState;
    handles.set(state, handle);
    return state;
  }
  if (backend === "wasm") {
    const result = wasmAny().core_create_thread(
      String(init.threadId),
      JSON.stringify(init.config),
      init.rootAgent === undefined ? undefined : JSON.stringify(init.rootAgent),
    );
    return JSON.parse(result) as ThreadState;
  }
  throw new Error("native core is off");
}

/** Fold one adapter fact and recompute statuses. */
export function apply(
  state: ThreadState,
  fact: unknown,
  ctx: ApplyContext,
): EventPayload[] {
  const backend = coreBackend();
  const factJson = JSON.stringify(fact);
  if (backend === "native") {
    return applyResult(state, handleFor(state).apply(factJson, ctx.now, idsNext(ctx)));
  }
  if (backend === "wasm") {
    return applyResult(
      state,
      wasmAny().core_apply(JSON.stringify(state), factJson, ctx.now, idsNext(ctx)),
    );
  }
  throw new Error("native core is off");
}

/** A provider frame commits atomically; see `FactBatch` in `reduce.ts`. */
export class FactBatch {
  private readonly state: ThreadState;
  private readonly native: boolean;
  constructor(state: ThreadState, stableSignals?: { deadline: number | undefined }) {
    this.state = state;
    this.native = coreBackend() !== "typescript";
    if (!this.native) throw new Error("native FactBatch is off");
    handleFor(state).batchBegin(
      stableSignals === undefined ? undefined : JSON.stringify(stableSignals.deadline ?? null),
    );
  }
  apply(fact: Fact, ctx: ApplyContext): EventPayload[] {
    return applyResult(
      this.state,
      handleFor(this.state).batchApply(JSON.stringify(fact), ctx.now, idsNext(ctx)),
    );
  }
  flush(): EventPayload[] {
    return applyResult(this.state, handleFor(this.state).batchFlush());
  }
}

/** Derive one agent's status for the current fact, descendants first. */
export function deriveAgentStatus(
  state: ThreadState,
  key: string,
  now: number,
): AgentStatus {
  const backend = coreBackend();
  if (backend === "native")
    return JSON.parse(addon().coreDeriveAgentStatus(JSON.stringify(state), key, now)) as AgentStatus;
  return JSON.parse(wasmAny().core_derive_agent_status(JSON.stringify(state), key, now)) as AgentStatus;
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
  if (backend === "native") return addon().coreNextDeadline(JSON.stringify(state), providerDeadline);
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
  private readonly wasmHandle:
    | InstanceType<WasmExports["WasmDeadlineIndex"]>
    | undefined;
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
    if (this.handle) return this.handle.next(providerDeadline);
    return this.wasmHandle?.next(providerDeadline);
  }
}

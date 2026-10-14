import {
  JsonRpcPeer,
  MethodNotFound,
  type Notification,
  type ServerRequest,
} from "@ace/provider-kit/jsonrpc";
import type { OutputFlow } from "@ace/provider-kit/flow-control";
import type { ProcessExit, SupervisedProcess } from "@ace/provider-kit/process";
import { HostRouter, type Route } from "./host-routing.ts";
import { obj, str } from "./native.ts";
import { parentOf } from "./session-state.ts";

/** A process exit, or `detached` when a shared process stopped serving one channel. */
export type HostExit = Omit<ProcessExit, "reason"> & {
  reason: ProcessExit["reason"] | "detached";
  pid?: number;
  /** False means the final descriptor drain was cut short. */
  outputDrained: boolean;
};

export type ChannelHandlers = {
  flow?: OutputFlow;
  frame(dir: "send" | "recv", data: unknown): void;
  notification(message: Notification): void;
  request(message: ServerRequest): unknown;
  malformed(line: string): void;
  stderr(line: string): void;
  error(error: Error): void;
  /** A received frame could not be admitted. The channel must retire. */
  failed(error: Error): void;
  /** Called once, after detach completes or the process exits. */
  exited(exit: HostExit): void;
};

export type Retirement = "idle" | "user" | "shutdown" | "aborted" | "open_failed" | "rpc_failed";

/** One ace session's view of an app-server: only its own threads' traffic reaches it. */
export interface CodexChannel {
  readonly pid: number | undefined;
  readonly shared: boolean;
  /** The process leader already exited; final output may still be draining. */
  readonly gone: boolean;
  /** No other channel shares this process. */
  readonly alone: boolean;
  request(
    method: string,
    params: unknown,
    options: { timeoutMs: number | null; signal?: AbortSignal },
  ): Promise<unknown>;
  /** Stop routing to this channel. A shared process unsubscribes its threads and keeps serving. */
  detach(retirement: Retirement, reason: Error): Promise<void>;
  /** Stop the whole process. Every channel on it exits. */
  retire(): Promise<void>;
  /** The thread provably belongs to another channel on this process. */
  foreign(thread: string): boolean;
}

export type HostConfig = {
  spawn(flow: OutputFlow): SupervisedProcess;
  /** A dedicated host serves one channel and stops with it; every frame goes to that channel. */
  dedicated: boolean;
  initialize: unknown;
  graceMs: number;
  /** How long a shared host with no channels stays up for the next session. */
  idleMs: number;
  schedule(callback: () => void, delayMs: number): () => void;
  onRetired(): void;
};

const holdThreads = 64;
const holdFrames = 256;
const ancestryDepth = 16;
const unsubscribeMs = 10_000;
const readMs = 10_000;

type Held = {
  data: Record<string, unknown>;
  /** Server requests need one answer; they are never fanned out. */
  request?: boolean;
  dispatch?: (tenant: Tenant | undefined) => void;
};
type Hold = { items: Held[]; resolving: boolean; chain?: string[] };
type Received = { data: unknown; route: Route<Tenant>; held?: Held; failed?: Set<Tenant> };

class Tenant implements CodexChannel {
  readonly host: CodexHost;
  readonly handlers: ChannelHandlers;
  readonly abort = new AbortController();
  closed: Error | undefined;
  /** A received frame failed admission; requests still flow so the tree can be stopped. */
  muted = false;
  exited = false;
  constructor(host: CodexHost, handlers: ChannelHandlers) {
    this.host = host;
    this.handlers = handlers;
  }
  get pid(): number | undefined {
    return this.host.pid;
  }
  get shared(): boolean {
    return !this.host.dedicated;
  }
  get gone(): boolean {
    return this.host.gone;
  }
  get alone(): boolean {
    return this.host.alone(this);
  }
  request(
    method: string,
    params: unknown,
    options: { timeoutMs: number | null; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.abort.signal])
      : this.abort.signal;
    return this.host.send(this, method, params, { timeoutMs: options.timeoutMs, signal });
  }
  detach(retirement: Retirement, reason: Error): Promise<void> {
    return this.host.detach(this, retirement, reason);
  }
  retire(): Promise<void> {
    return this.host.retire();
  }
  foreign(thread: string): boolean {
    return this.host.foreign(this, thread);
  }
  /** Delivery failures retire only this channel; the shared peer keeps reading. */
  deliver(dir: "send" | "recv", data: unknown): boolean {
    if (this.closed || this.muted) return false;
    try {
      this.handlers.frame(dir, data);
      return true;
    } catch (error) {
      if (dir === "send") throw error;
      // Nothing after an unadmitted frame may reach translation, as when a private peer closes.
      this.muted = true;
      this.handlers.failed(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
  exit(exit: HostExit): void {
    if (this.exited) return;
    this.exited = true;
    this.handlers.exited(exit);
  }
}

/**
 * One `codex app-server` process. Shared hosts serve many ace threads, as Codex intends; each
 * channel sees only the native threads it opened and their descendants.
 */
export class CodexHost {
  readonly dedicated: boolean;
  readonly #config: HostConfig;
  readonly #router = new HostRouter<Tenant>();
  readonly #tenants = new Set<Tenant>();
  readonly #holds = new Map<string, Hold>();
  readonly #initFrames: { dir: "send" | "recv"; data: unknown }[] = [];
  readonly #proc: SupervisedProcess;
  readonly #peer: JsonRpcPeer;
  readonly #ready: Promise<void>;
  #sender: Tenant | undefined;
  #last: Received | undefined;
  #exit: HostExit | undefined;
  #retiring: Promise<void> | undefined;
  #cancelIdle: (() => void) | undefined;
  #cancelDrain: (() => void) | undefined;
  #outputDrained = true;
  #initializeId: unknown;

  constructor(config: HostConfig) {
    this.#config = config;
    this.dedicated = config.dedicated;
    const tenants = this.#tenants;
    this.#proc = config.spawn({
      // Shared stdout pauses while any channel is out of room; no channel loses a frame.
      paused: () => [...tenants].some((tenant) => tenant.handlers.flow?.paused() ?? false),
      wait: async () => {
        await Promise.all(
          [...tenants].map((tenant) =>
            tenant.handlers.flow?.paused() ? tenant.handlers.flow.wait() : undefined,
          ),
        );
      },
    });
    const proc = this.#proc;
    const drain = () => {
      // Leader exit is independent of inherited pipe EOF. Bound the final drain.
      this.#cancelDrain = config.schedule(() => {
        this.#outputDrained = false;
        proc.stdout.close();
        proc.stderr.close();
        proc.stdin.destroy();
      }, 250);
    };
    proc.signal.addEventListener("abort", drain, { once: true });
    if (proc.signal.aborted) drain();
    proc.stderr.on("line", (line) => {
      for (const tenant of this.#tenants) tenant.handlers.stderr(line);
    });
    this.#peer = new JsonRpcPeer(proc, {
      timeoutMs: null,
      ...(config.dedicated ? {} : { maxPendingRequests: 1024, maxIncomingRequests: 512 }),
      onFrame: (dir, data) => (dir === "send" ? this.#sent(data) : this.#received(data)),
      onMalformed: (line) => {
        for (const tenant of this.#tenants) tenant.handlers.malformed(line);
      },
      onError: (error) => {
        for (const tenant of this.#tenants) tenant.handlers.error(error);
      },
    });
    const peer = this.#peer;
    peer.onNotification = (message) => this.#notification(message);
    peer.onRequest = (message) => this.#request(message);
    void proc.exited.then((exit) => {
      this.#cancelDrain?.();
      proc.signal.removeEventListener("abort", drain);
      this.#exited({
        ...exit,
        ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
        outputDrained: this.#outputDrained,
      });
    });
    this.#ready = (async () => {
      await peer.request("initialize", config.initialize, { timeoutMs: 30_000 });
      await peer.notify("initialized");
    })();
    // Failure is observed by each attach; an unobserved rejection must not crash the daemon.
    this.#ready.catch(() => {});
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }
  get gone(): boolean {
    return this.#proc.signal.aborted;
  }
  /** Accepts new channels: running, and not winding down. */
  get available(): boolean {
    return !this.#exit && !this.#retiring && !this.#proc.signal.aborted;
  }

  /** Register before initialization completes so a dedicated channel sees every frame live. */
  async attach(handlers: ChannelHandlers, signal: AbortSignal): Promise<CodexChannel> {
    if (!this.available) throw new Error("Codex app-server is not available");
    if (this.dedicated && this.#tenants.size) throw new Error("Dedicated Codex host is in use");
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
    const tenant = new Tenant(this, handlers);
    for (const frame of this.#initFrames) tenant.deliver(frame.dir, frame.data);
    this.#tenants.add(tenant);
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void this.#ready.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", abort);
        });
      });
      if (this.#exit) throw new Error("process exited");
      return tenant;
    } catch (error) {
      tenant.closed = error instanceof Error ? error : new Error(String(error));
      tenant.exited = true;
      this.#tenants.delete(tenant);
      this.#router.release(tenant);
      void this.#vacated(false);
      throw error;
    }
  }

  send(
    tenant: Tenant,
    method: string,
    params: unknown,
    options: { timeoutMs: number | null; signal: AbortSignal },
  ): Promise<unknown> {
    // The peer emits the send frame synchronously inside request(); attribute it to its sender.
    this.#sender = tenant;
    try {
      return this.#peer.request(method, params, options);
    } finally {
      this.#sender = undefined;
    }
  }

  async detach(tenant: Tenant, retirement: Retirement, reason: Error): Promise<void> {
    if (tenant.closed) return;
    tenant.closed = reason;
    tenant.abort.abort(reason);
    if (this.dedicated || this.#exit) {
      // A dedicated process belongs to this channel; its exit is the channel's exit.
      await this.retire();
      return;
    }
    this.#tenants.delete(tenant);
    const threads = this.#router.release(tenant);
    await Promise.allSettled(
      threads.map((threadId) => this.#own("thread/unsubscribe", { threadId }, unsubscribeMs)),
    );
    tenant.exit({
      reason: "detached",
      code: null,
      signal: null,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      outputDrained: true,
    });
    await this.#vacated(retirement === "shutdown");
  }

  alone(tenant: Tenant): boolean {
    return [...this.#tenants].every((other) => other === tenant);
  }

  foreign(tenant: Tenant, thread: string): boolean {
    const owner = this.#router.owner(thread);
    return owner !== undefined ? owner !== tenant : this.#router.released(thread);
  }

  retire(): Promise<void> {
    if (this.#retiring) return this.#retiring;
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
    this.#config.onRetired();
    this.#retiring = this.#proc.stop({ graceMs: this.#config.graceMs }).then(() => {});
    return this.#retiring;
  }

  async #vacated(now: boolean): Promise<void> {
    if (this.#tenants.size || !this.available) return;
    if (this.dedicated || now) {
      await this.retire();
      return;
    }
    this.#cancelIdle?.();
    this.#cancelIdle = this.#config.schedule(() => {
      this.#cancelIdle = undefined;
      if (!this.#tenants.size) void this.retire();
    }, this.#config.idleMs);
  }

  #exited(exit: HostExit): void {
    this.#exit = exit;
    this.#cancelIdle?.();
    this.#config.onRetired();
    for (const hold of this.#holds.values())
      for (const item of hold.items) item.dispatch?.(undefined);
    this.#holds.clear();
    const tenants = [...this.#tenants];
    this.#tenants.clear();
    for (const tenant of tenants) {
      tenant.closed ??= new Error("process exited");
      tenant.abort.abort(tenant.closed);
      tenant.exit(exit);
    }
  }

  #own(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.#sender = undefined;
    return this.#peer.request(method, params, { timeoutMs });
  }

  #sent(data: unknown): void {
    const message = obj(data);
    const tenant = this.#router.sent(message, this.#sender);
    if (tenant) {
      tenant.deliver("send", data);
      return;
    }
    const method = str(message["method"]);
    if (method === "initialize") this.#initializeId = message["id"];
    if (method === "initialize" || method === "initialized") this.#broadcastInit("send", data);
  }

  #broadcastInit(dir: "send" | "recv", data: unknown): void {
    this.#initFrames.push({ dir, data });
    for (const tenant of this.#tenants) tenant.deliver(dir, data);
  }

  #route(message: Record<string, unknown>): Route<Tenant> {
    const route = this.#router.received(message);
    const [only, ...others] = this.#tenants;
    if (this.dedicated && route.to !== "host")
      return only ? { to: "tenant", tenant: only, claimed: [] } : { to: "drop" };
    // A lone channel is the only possible owner; its own discovery decides, as on a private
    // process. Ancestry lookups are for telling neighbours apart.
    if (route.to === "hold" && only && !others.length)
      return { to: "tenant", tenant: only, claimed: [] };
    return route;
  }

  #received(data: unknown): void {
    const message = obj(data);
    const route = this.#route(message);
    this.#last = { data, route };
    if (route.to === "host") {
      if (message["id"] === this.#initializeId) this.#broadcastInit("recv", data);
      return;
    }
    if (route.to === "drop") return;
    if (route.to === "hold") {
      const held: Held = { data: message };
      this.#last.held = held;
      this.#hold(route.thread, held);
      return;
    }
    if (route.to === "all") {
      const failed = new Set<Tenant>();
      for (const tenant of this.#tenants) if (!tenant.deliver("recv", data)) failed.add(tenant);
      this.#last.failed = failed;
      return;
    }
    for (const thread of route.claimed) this.#claimed(thread, route.tenant);
    if (!route.tenant.deliver("recv", data)) this.#last.failed = new Set([route.tenant]);
    if (this.#router.opening === 0) this.#settleWaiting();
  }

  #notification(message: Notification): void {
    const last = this.#last;
    this.#last = undefined;
    if (!last) return;
    const route = last.route;
    if (last.held) {
      last.held.dispatch = (tenant) => tenant?.handlers.notification(message);
      return;
    }
    if (route.to === "tenant" && !last.failed?.has(route.tenant))
      route.tenant.handlers.notification(message);
    if (route.to === "all")
      for (const tenant of this.#tenants)
        if (!last.failed?.has(tenant)) tenant.handlers.notification(message);
  }

  #request(message: ServerRequest): unknown {
    const last = this.#last;
    this.#last = undefined;
    const route = last?.route;
    if (last?.held) {
      const held = last.held;
      held.request = true;
      return new Promise((resolve, reject) => {
        held.dispatch = (tenant) => {
          if (!tenant) {
            reject(new MethodNotFound("Codex request has no ace owner"));
            return;
          }
          this.#router.serve(message.id, tenant);
          try {
            resolve(tenant.handlers.request(message));
          } catch (error) {
            reject(error);
          }
        };
      });
    }
    if (route?.to === "tenant" && !last?.failed?.has(route.tenant)) {
      this.#router.serve(message.id, route.tenant);
      return route.tenant.handlers.request(message);
    }
    // A request naming no thread or turn can only be answered when one session could own it.
    const [only, ...others] = this.#tenants;
    if (route?.to === "host" && only && !others.length && only.deliver("recv", last?.data)) {
      this.#router.serve(message.id, only);
      return only.handlers.request(message);
    }
    throw new MethodNotFound(`Unsupported Codex request: ${message.method}`);
  }

  /** A thread just became owned: release what waited for it, then anything below it. */
  #claimed(thread: string, tenant: Tenant): void {
    const hold = this.#holds.get(thread);
    if (hold) {
      this.#holds.delete(thread);
      this.#flush(hold, tenant);
    }
    for (const [waiting, entry] of this.#holds)
      if (entry.chain?.includes(thread)) {
        this.#holds.delete(waiting);
        for (const member of entry.chain) this.#router.claim(member, tenant);
        this.#flush(entry, tenant);
      }
  }

  #flush(hold: Hold, tenant: Tenant | "all" | undefined): void {
    for (const item of hold.items) {
      if (tenant === undefined) {
        item.dispatch?.(undefined);
        continue;
      }
      if (tenant === "all" && item.request) {
        // No owner could be proven. Answering for every channel would duplicate a prompt.
        item.dispatch?.(undefined);
        continue;
      }
      const targets = tenant === "all" ? [...this.#tenants] : [tenant];
      for (const target of targets) {
        const owned = target.deliver("recv", item.data);
        if (owned) item.dispatch?.(target);
        else if (tenant !== "all") item.dispatch?.(undefined);
      }
    }
  }

  #hold(thread: string, held: Held): void {
    let hold = this.#holds.get(thread);
    if (!hold) {
      if (this.#holds.size >= holdThreads) {
        // Bounded: the oldest unresolved thread falls back to every channel's own discovery.
        const [oldest, entry] = this.#holds.entries().next().value ?? [];
        if (oldest !== undefined && entry) {
          this.#holds.delete(oldest);
          this.#flush(entry, "all");
        }
      }
      hold = { items: [], resolving: false };
      this.#holds.set(thread, hold);
    }
    hold.items.push(held);
    if (hold.items.length > holdFrames) {
      this.#holds.delete(thread);
      this.#flush(hold, "all");
      return;
    }
    if (!hold.resolving && !hold.chain) void this.#resolve(thread, hold);
  }

  /** Find an owned ancestor through Codex's own thread records. */
  async #resolve(thread: string, hold: Hold): Promise<void> {
    hold.resolving = true;
    const chain = [thread];
    let unreadable = false;
    try {
      for (let cursor = thread, depth = 0; depth < ancestryDepth; depth++) {
        const owner = this.#router.owner(cursor);
        if (owner) {
          if (this.#holds.get(thread) !== hold) return;
          this.#holds.delete(thread);
          for (const member of chain) this.#router.claim(member, owner);
          this.#flush(hold, owner);
          for (const member of chain) this.#claimed(member, owner);
          return;
        }
        const result = obj(await this.#own("thread/read", { threadId: cursor }, readMs));
        const parent = parentOf(obj(result["thread"]));
        if (!parent || chain.includes(parent)) break;
        chain.push(parent);
        cursor = parent;
      }
    } catch {
      unreadable = true;
    } finally {
      hold.resolving = false;
    }
    if (this.#holds.get(thread) !== hold) return;
    for (const member of chain) {
      const owner = this.#router.owner(member);
      if (owner) {
        this.#holds.delete(thread);
        for (const entry of chain) this.#router.claim(entry, owner);
        this.#flush(hold, owner);
        return;
      }
    }
    if (unreadable) {
      // Without ancestry, every channel checks for itself, as a dedicated process would.
      this.#holds.delete(thread);
      this.#flush(hold, "all");
      return;
    }
    hold.chain = chain;
    // A resumed root may still be claimed by an open in flight; decide once none remain.
    if (this.#router.opening === 0) this.#settleWaiting();
  }

  #settleWaiting(): void {
    for (const [thread, hold] of this.#holds) {
      if (!hold.chain || hold.resolving) continue;
      this.#holds.delete(thread);
      // Codex's ancestry reaches no ace thread: another client's thread on this process.
      this.#flush(hold, undefined);
    }
  }
}

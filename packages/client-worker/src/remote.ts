import {
  pendingSend,
  matchesPendingThread,
  pendingSendsEqual,
  type PendingSend,
  deferredProjectsApi,
  downloadFile,
  uploadFile,
  type FileDownloadInput,
  type FileUploadInput,
} from "@ace/client";
import {
  ClientError,
  isOneWayMessage,
  Notifications,
  defaultLimits,
  type TurnsPageInput,
  type ItemsWindowInput,
  type ThreadSearchInput,
  type ThreadCatchUpInput,
  type ThreadReadStateInput,
  type ThreadMarkReadInput,
  type ClientApi,
  type ConnectionState,
  type Intent,
  type Lease,
  type OneWayMessage,
  type OutputData,
  type RegistryQuery,
  type RequestOptions,
  type Scheduler,
  type Selection,
  type SidebarExport,
  type ServiceRequest,
  type ServiceResponse,
  type SidebarSource,
  type ThreadExport,
  type ThreadSource,
} from "@ace/client";
import type {
  TurnsPageResponse,
  ItemsWindowResponse,
  ThreadSearchResponse,
  ThreadCatchUpResponse,
  ThreadReadStateResponse,
  CommandPayload,
  CommandResult,
  ItemsPage,
  RegistryResult,
  ServerMessage,
  TextSource,
} from "@ace/protocol";
import { MirrorSidebar, MirrorThread } from "./mirror.ts";
import { toError, trusted } from "./trusted.ts";
import {
  WorkerMessage,
  type CallMethod,
  type IterateMethod,
  type PortLike,
  type Scope,
  type TabMessage,
} from "./wire.ts";

/*
 * The tab side (ADR 0056): a ClientApi whose stores are mirrors of the worker's. Reads are
 * synchronous against the mirror; requests travel to the worker's client and back.
 */

/** Whether the page is on screen (document.visibilityState in a browser). */
export interface Visibility {
  visible(): boolean;
  watch(changed: () => void): () => void;
}
/** Proof that this tab is alive, for as long as it lives (a Web Lock in a browser). */
export interface Liveness {
  /** Resolves once the lock is held, with its name and a way to let it go. */
  hold(): Promise<{ name: string; release(): void }>;
}
export interface RemoteOptions {
  /** Command ids are allocated in the tab before sending its first worker message. */
  id?(): string;
  scheduler: Scheduler;
  /** While the page is hidden the worker sends it nothing (ADR 0056). Always visible if absent. */
  visibility?: Visibility;
  /** Called once the worker's client has loaded its outbox for this tab. */
  attached?(): void;
  /** Interval of the liveness ping that keeps this tab's leases in the worker. */
  pingMs?: number;
  /**
   * Where the browser has it, a lock the worker watches instead of pings: throttled or frozen
   * hidden tabs keep their leases, and a closed tab's are released at once.
   */
  liveness?: Liveness;
  /** Sent intents nobody watches that a tab remembers, for a watcher that subscribes late. */
  unwatchedIntents?: number;
  listeners?: number;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: ClientError): void;
}
interface Mirrored {
  refs: number;
  lease: number;
  mirror: MirrorThread | MirrorSidebar;
}

const states = new Set<string>(["connecting", "ready", "reconnecting", "offline", "fatal"]);
const isState = (state: string): state is ConnectionState => states.has(state);

export class RemoteClient implements ClientApi {
  readonly projects = deferredProjectsApi(this, () => import("@ace/client/project-calls"));
  private port: PortLike;
  private config: unknown;
  private options: RemoteOptions;
  private notifications: Notifications;
  private current: ConnectionState = "connecting";
  private failure: ClientError | undefined;
  private intents = new Map<string, { value: Intent | undefined; watchers: number }>();
  private sends = new Map<string, PendingSend>();
  private localSaving = new Set<string>();
  private pendingWatchers = 0;
  private mirrors = new Map<string, Mirrored>();
  private byLease = new Map<number, Mirrored>();
  private pending = new Map<number, Pending>();
  private messageListeners = new Set<(message: ServerMessage) => void>();
  private sequence = 0;
  private attached: Promise<void>;
  private settle: Pending | undefined;
  private stopPing: (() => void) | undefined;
  private releaseLock: (() => void) | undefined;
  private unwatch: (() => void) | undefined;
  private closed = false;
  private listener = (event: { data: unknown }) => this.receive(event.data);
  constructor(port: PortLike, config: unknown, options: RemoteOptions) {
    this.port = port;
    this.config = config;
    this.options = options;
    this.notifications = new Notifications(options.listeners ?? defaultLimits.listeners);
    this.attached = new Promise<void>((resolve, reject) => {
      this.settle = { resolve: () => resolve(), reject };
    });
    port.addEventListener("message", this.listener);
    port.start?.();
  }
  get state(): ConnectionState {
    return this.current;
  }
  get error(): ClientError | undefined {
    return this.failure;
  }
  connectionState(): Selection<ConnectionState> {
    return this.notifications.select(["connection"], () => this.current);
  }
  intent(id: string): Selection<Intent | undefined> {
    const read = () => this.intents.get(id)?.value;
    const inner = this.notifications.select([`intent:${id}`], read);
    return {
      getSnapshot: inner.getSnapshot,
      subscribe: (listener) => {
        const record = this.intents.get(id) ?? { value: undefined, watchers: 0 };
        this.intents.set(id, record);
        if (record.watchers++ === 0) this.post({ t: "watchIntent", id });
        const stop = inner.subscribe(listener);
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          stop();
          if (--record.watchers === 0) {
            this.post({ t: "unwatchIntent", id });
            this.intents.delete(id);
          }
        };
      },
    };
  }
  pendingSends(threadId?: string): Selection<readonly PendingSend[]> {
    const inner = this.notifications.select(
      ["pendingSends"],
      () => [...this.sends.values()].filter((entry) => matchesPendingThread(entry, threadId)),
      pendingSendsEqual,
    );
    return {
      getSnapshot: inner.getSnapshot,
      subscribe: (listener) => {
        if (this.pendingWatchers++ === 0) this.post({ t: "watchPendingSends" });
        const stop = inner.subscribe(listener);
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          stop();
          if (--this.pendingWatchers === 0) this.post({ t: "unwatchPendingSends" });
        };
      },
    };
  }
  private saving(payload: CommandPayload, id: string): void {
    if (payload.type !== "thread.send" && payload.type !== "thread.create") return;
    if (this.sends.has(id)) return;
    this.localSaving.add(id);
    this.sends.set(id, {
      commandId: id,
      itemId: `input:${id}`,
      threadId: payload.threadId ?? `pending:${id}`,
      payload,
      state: "saving",
      waiting: false,
    });
    this.notifications.emit(["pendingSends"]);
  }
  /** Attach to the worker's client for this target; resolves once its outbox is loaded. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new ClientError("offline"));
    this.post({ t: "connect", config: this.config });
    const visibility = this.options.visibility;
    if (visibility) {
      const report = () => this.visible(visibility.visible());
      this.unwatch = visibility.watch(report);
      if (!visibility.visible()) report();
    }
    const ping = () => {
      this.stopPing = this.options.scheduler.set(this.options.pingMs ?? 5_000, () => {
        this.post({ t: "ping" });
        ping();
      });
    };
    ping();
    void this.options.liveness?.hold().then(
      (held) => {
        if (this.closed) return held.release();
        this.releaseLock = held.release;
        this.post({ t: "alive", lock: held.name });
      },
      () => {
        /* No lock: the pings keep this tab alive. */
      },
    );
    return this.attached;
  }
  /** Leave the worker. Its client keeps running while other tabs use it. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopPing?.();
    this.unwatch?.();
    this.post({ t: "bye" });
    this.releaseLock?.();
    this.port.removeEventListener("message", this.listener);
    this.port.close?.();
    for (const pending of this.pending.values()) pending.reject(new ClientError("offline"));
    this.pending.clear();
    this.messageListeners.clear();
    this.settle?.reject(new ClientError("offline"));
  }
  /** Hidden tabs receive nothing; on return they get everything that changed meanwhile. */
  private visible(visible: boolean): void {
    this.post({ t: "visible", visible });
  }
  networkOnline(online: boolean): void {
    void this.call("networkOnline", [online]).catch(() => {});
  }
  thread(id: string): Lease<ThreadSource> {
    return this.hold(
      `thread:${id}`,
      { kind: "thread", threadId: id },
      () => new MirrorThread(this.listeners),
    );
  }
  threads(): Lease<SidebarSource> {
    return this.hold("threads", { kind: "threads" }, () => new MirrorSidebar(this.listeners));
  }
  async enqueue(
    payload: CommandPayload,
    id = this.options.id?.() ?? crypto.randomUUID(),
  ): Promise<string> {
    this.saving(payload, id);
    let result: unknown;
    try {
      result = await this.call("enqueue", [payload, id]);
    } catch (error) {
      const previous = this.sends.get(id);
      if (previous)
        this.sends.set(id, {
          ...previous,
          state: "failed",
          error: error instanceof Error ? error.message : "storage",
        });
      this.notifications.emit(["pendingSends"]);
      throw error;
    } finally {
      this.localSaving.delete(id);
    }
    const { id: sent, intent } = trusted<{ id: string; intent: Intent | undefined }>(result);
    const record = this.intents.get(sent);
    if (record) record.value = intent;
    else {
      this.intents.set(sent, { value: intent, watchers: 0 });
      this.forgetUnwatchedIntents();
    }
    if (intent) {
      const entry = pendingSend(intent);
      if (entry) this.sends.set(sent, entry);
    }
    this.notifications.emit([`intent:${sent}`, "pendingSends"]);
    return sent;
  }
  command(
    payload: CommandPayload,
    options: RequestOptions = {},
    id = this.options.id?.() ?? crypto.randomUUID(),
  ) {
    this.saving(payload, id);
    const args = [payload, timeout(options), id];
    return this.invoke<CommandResult>("command", args, options.signal);
  }
  registry(input: RegistryQuery, options: RequestOptions = {}) {
    return this.invoke<RegistryResult>("registry", [input, timeout(options)], options.signal);
  }
  request<Q extends ServiceRequest>(
    input: Q,
    options: RequestOptions = {},
  ): Promise<ServiceResponse<Q>> {
    return this.invoke<ServiceResponse<Q>>("request", [input, timeout(options)], options.signal);
  }
  onMessage(listener: (message: ServerMessage) => void): () => void {
    if (this.closed) throw new ClientError("offline");
    if (this.messageListeners.size >= this.listeners) throw new ClientError("limit");
    if (this.messageListeners.size === 0) this.post({ t: "watchMessages" });
    this.messageListeners.add(listener);
    return () => {
      if (!this.messageListeners.delete(listener)) return;
      if (this.messageListeners.size === 0) this.post({ t: "unwatchMessages" });
    };
  }
  send(message: OneWayMessage): void {
    // The worker's client validates the whole message again before it reaches the socket.
    if (!isOneWayMessage(message)) throw new ClientError("protocol", "Invalid one-way message");
    if (this.closed || this.current !== "ready") throw new ClientError("offline");
    this.post({ t: "send", message });
  }
  downloadFile(input: FileDownloadInput, options: RequestOptions = {}): AsyncGenerator<Uint8Array> {
    return downloadFile(this, input, options);
  }
  uploadFile(
    input: FileUploadInput,
    source: AsyncIterable<Uint8Array>,
    options: RequestOptions = {},
  ): Promise<unknown> {
    return uploadFile(this, input, source, options);
  }
  turnsPage(input: TurnsPageInput, options: RequestOptions = {}) {
    return this.invoke<TurnsPageResponse>("turnsPage", [input, timeout(options)], options.signal);
  }
  itemsWindow(input: ItemsWindowInput, options: RequestOptions = {}) {
    return this.invoke<ItemsWindowResponse>(
      "itemsWindow",
      [input, timeout(options)],
      options.signal,
    );
  }
  threadSearch(input: ThreadSearchInput, options: RequestOptions = {}) {
    return this.invoke<ThreadSearchResponse>(
      "threadSearch",
      [input, timeout(options)],
      options.signal,
    );
  }
  threadCatchUp(input: ThreadCatchUpInput, options: RequestOptions = {}) {
    return this.invoke<ThreadCatchUpResponse>(
      "threadCatchUp",
      [input, timeout(options)],
      options.signal,
    );
  }
  threadReadState(input: ThreadReadStateInput, options: RequestOptions = {}) {
    return this.invoke<ThreadReadStateResponse>(
      "threadReadState",
      [input, timeout(options)],
      options.signal,
    );
  }
  markThreadRead(input: ThreadMarkReadInput, options: RequestOptions = {}) {
    return this.invoke<CommandResult>("markThreadRead", [input, timeout(options)], options.signal);
  }
  itemsPage(
    payload: { threadId: string; before?: number | undefined; limit: number },
    options: RequestOptions = {},
  ) {
    return this.invoke<ItemsPage>("itemsPage", [payload, timeout(options)], options.signal);
  }
  async loadOlder(threadId: string, limit: number, options: RequestOptions = {}): Promise<void> {
    await this.call("loadOlder", [threadId, limit, timeout(options)], options.signal);
  }
  outputRead(
    payload: { streamId: string; offset: number; limit: number },
    options: RequestOptions = {},
  ) {
    return this.invoke<OutputData>("outputRead", [payload, timeout(options)], options.signal);
  }
  text(source: TextSource, options: RequestOptions = {}): AsyncGenerator<string> {
    return this.stream<string>("text", [source, timeout(options)], options.signal);
  }
  output(
    payload: { streamId: string; offset: number; limit: number },
    options: RequestOptions = {},
  ): AsyncGenerator<Uint8Array> {
    return this.stream<Uint8Array>("output", [payload, timeout(options)], options.signal);
  }

  /** Keeps only the newest sent intents nobody watches; each holds its whole command. */
  private forgetUnwatchedIntents(): void {
    let excess = -(this.options.unwatchedIntents ?? 64);
    for (const record of this.intents.values()) if (record.watchers === 0) excess++;
    // Maps iterate in insertion order: the oldest go first.
    for (const [id, record] of this.intents) {
      if (excess <= 0) return;
      if (record.watchers > 0) continue;
      this.intents.delete(id);
      excess--;
    }
  }
  private get listeners() {
    return this.options.listeners ?? defaultLimits.listeners;
  }
  private post(message: TabMessage): void {
    // A MessagePort has no target origin: it reaches exactly the other end.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    if (!this.closed || message.t === "bye") this.port.postMessage(message);
  }
  private hold<T extends MirrorThread | MirrorSidebar>(
    key: string,
    scope: Scope,
    create: () => T,
  ): Lease<T> {
    if (this.closed) throw new ClientError("offline");
    let held = this.mirrors.get(key);
    if (!held) {
      held = { refs: 0, lease: ++this.sequence, mirror: create() };
      this.mirrors.set(key, held);
      this.byLease.set(held.lease, held);
      this.post({ t: "lease", lease: held.lease, scope });
    }
    held.refs++;
    const owned = held;
    let released = false;
    return {
      store: trusted<T>(owned.mirror),
      release: () => {
        if (released) return;
        released = true;
        if (--owned.refs) return;
        this.mirrors.delete(key);
        this.byLease.delete(owned.lease);
        this.post({ t: "release", lease: owned.lease });
      },
    };
  }
  private async invoke<T>(method: CallMethod, args: unknown[], signal?: AbortSignal): Promise<T> {
    return trusted<T>(await this.call(method, args, signal));
  }
  private call(method: CallMethod, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new ClientError("offline"));
    if (signal?.aborted) return Promise.reject(new ClientError("aborted"));
    const call = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.post({ t: "abort", call });
        this.pending.delete(call);
        reject(new ClientError("aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(call, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.post({ t: "call", call, method, args });
    });
  }
  private async *stream<T>(
    method: IterateMethod,
    args: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<T> {
    if (this.closed) throw new ClientError("offline");
    const call = ++this.sequence;
    const step = () =>
      new Promise<unknown>((resolve, reject) => this.pending.set(call, { resolve, reject }));
    const abort = () => {
      this.post({ t: "return", call });
      this.pending.get(call)?.reject(new ClientError("aborted"));
      this.pending.delete(call);
    };
    signal?.addEventListener("abort", abort, { once: true });
    let done = false;
    try {
      let next = step();
      this.post({ t: "iterate", call, method, args });
      for (;;) {
        const result = trusted<{ done: boolean; value?: T }>(await next);
        if (result.done) {
          done = true;
          return;
        }
        next = step();
        yield trusted<T>(result.value);
        this.post({ t: "next", call });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(call);
      if (!done) this.post({ t: "return", call });
    }
  }
  private receive(data: unknown): void {
    const parsed = WorkerMessage.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.t) {
      case "attached":
        if (message.error) this.settle?.reject(toError(message.error));
        else {
          this.settle?.resolve(undefined);
          this.options.attached?.();
        }
        return;
      case "connection":
        if (!isState(message.state)) return;
        this.current = message.state;
        this.failure = message.error && toError(message.error);
        this.notifications.emit(["connection"]);
        return;
      case "pendingSends": {
        if (message.reset)
          for (const id of this.sends.keys()) if (!this.localSaving.has(id)) this.sends.delete(id);
        for (const id of message.removed) this.sends.delete(id);
        for (const value of message.entries) {
          const entry = trusted<PendingSend>(value);
          this.sends.set(entry.commandId, entry);
          if (entry.state !== "saving") this.localSaving.delete(entry.commandId);
        }
        this.notifications.emit(["pendingSends"]);
        return;
      }
      case "intent": {
        const record = this.intents.get(message.id);
        if (!record) return;
        record.value = trusted<Intent | undefined>(message.intent);
        this.notifications.emit([`intent:${message.id}`]);
        return;
      }
      case "changes":
        for (const change of message.leases) {
          const held = this.byLease.get(change.lease);
          if (!held) continue;
          if (change.reset !== undefined) {
            if (held.mirror instanceof MirrorThread)
              held.mirror.reset(trusted<ThreadExport>(change.reset));
            else held.mirror.reset(trusted<SidebarExport>(change.reset));
          }
          if (change.patches) held.mirror.apply(change.patches);
        }
        return;
      case "reply":
      case "yield": {
        const pending = this.pending.get(message.call);
        if (!pending) return;
        if (message.t === "reply") this.pending.delete(message.call);
        pending.resolve(message.t === "reply" ? message.value : message);
        return;
      }
      case "message": {
        const pushed = trusted<ServerMessage>(message.message);
        for (const listener of this.messageListeners) {
          try {
            listener(pushed);
          } catch {
            // One consumer cannot break delivery to the others.
          }
        }
        return;
      }
      case "failed": {
        const pending = this.pending.get(message.call);
        this.pending.delete(message.call);
        pending?.reject(toError(message.error));
        return;
      }
    }
  }
}

const timeout = (options: RequestOptions) => ({
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
});

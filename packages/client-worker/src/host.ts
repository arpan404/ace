import {
  ClientError,
  defaultLimits,
  loadServiceWire,
  type Client,
  type PendingSend,
  type Scheduler,
  type SidebarExport,
  type ThreadExport,
} from "@ace/client";
import type { Item, ServerMessage } from "@ace/protocol";
import { sidebarPatches, threadPatches, type Patch } from "./patches.ts";
import { callArgs, iterateArgs, objectInput, sendArgs } from "./calls.ts";
import { TabChannels } from "./tab-channels.ts";
import { TabMessage, type LeaseChanges, type PortLike, type Scope } from "./wire.ts";

/*
 * The worker side (ADR 0056). One `Client` per daemon target is shared by every tab attached
 * to this worker: one socket, one decode, one projection and one intents outbox. Each tab holds
 * leases on stores; the host forwards the keys those stores emit, coalesced per frame, and
 * nothing at all to a hidden tab until it is visible again.
 */

export interface HostOptions {
  /** Parse a tab's target and name the client for it; tabs naming the same key share it. */
  target(config: unknown): { key: string; create(): Client };
  scheduler: Scheduler;
  now(): number;
  /** Coalescing window for forwarded changes. One display frame by default. */
  frameMs?: number;
  /** How long a client outlives its last tab, so a reload reattaches to a warm connection. */
  lingerMs?: number;
  /** A tab silent this long is gone (it pings meanwhile); its leases are released. */
  silenceMs?: number;
  /**
   * The same for a hidden tab. Browsers throttle a hidden page's timers (Chrome to one wake a
   * minute after five minutes) or freeze it, so its pings slow down or stop while it lives.
   */
  hiddenSilenceMs?: number;
  /**
   * Calls `gone` once the tab holding the named lock has closed or crashed (Web Locks in a
   * browser). A tab that names its lock is never dropped for silence; the lock tells.
   */
  lockReleased?(name: string, gone: () => void): () => void;
}

/**
 * A hidden tab's changed keys are kept until it shows again. Past this many it gets one copy of
 * the whole store instead, so a tab hidden through a month of streaming holds a bounded backlog.
 */
const backlogKeys = 1_024;

interface Entry {
  key: string;
  generation: number;
  client: Client;
  tabs: Set<Tab>;
  started: Promise<void>;
  unwatch: () => void;
  linger: (() => void) | undefined;
}
interface Held {
  scope: Scope;
  release(): void;
  unobserve(): void;
  read(keys: Iterable<string>): Patch[];
  copy(): ThreadExport | SidebarExport;
  dirty: Set<string> | "all" | undefined;
  sent: Map<string, Item>;
}

/** Stream and reply traffic the client consumes itself; tabs only get service pushes. */
const internal = new Set<string>([
  "welcome",
  "snapshot",
  "events",
  "progress",
  "commandResult",
  "error",
  "output.data",
  "items.page",
  "registry.result",
  "pong",
]);
const isServicePush = (message: ServerMessage) =>
  !internal.has(message.type) &&
  (message.type === "catalog.changed" ||
    message.type === "history.operation.progress" ||
    !("requestId" in message && message.requestId));

/** Requests that open or use a file channel or a Preview subscription (`tab-channels.ts`). */
const isChannelRequest = (input: unknown) => {
  const type = objectInput(input).type;
  return typeof type === "string" && (type.startsWith("files.") || type.startsWith("browser."));
};

/** One-way controls that belong to a file channel or a Preview subscription. */
const channelControls = new Set<string>([
  "files.request",
  "files.abort",
  "files.pull",
  "files.chunk",
  "files.credit",
  "files.cancel",
  "browser.subscribe",
  "browser.unsubscribe",
]);

const errorShape = (error: unknown) =>
  error instanceof ClientError
    ? { code: error.code, message: error.message }
    : { code: "protocol", message: error instanceof Error ? error.message : "Request failed" };

export class ClientHost {
  private options: HostOptions;
  private entries = new Map<string, Entry>();
  private tabs = new Set<Tab>();
  private sweep: (() => void) | undefined;
  private subscriberSequence = 0;
  subscriberId(): string {
    return `tab-${++this.subscriberSequence}`;
  }
  constructor(options: HostOptions) {
    this.options = options;
  }
  /** Serve one tab over its port until it says goodbye or falls silent. */
  attach(port: PortLike): void {
    const tab = new Tab(this, port, this.options);
    this.tabs.add(tab);
    this.scheduleSweep();
  }
  get clients(): number {
    return this.entries.size;
  }
  /** @internal */
  join(tab: Tab, config: unknown): Entry {
    const target = this.options.target(config);
    let entry = this.entries.get(target.key);
    if (!entry) {
      const client = target.create();
      const created: Entry = {
        key: target.key,
        generation: 0,
        client,
        tabs: new Set(),
        started: client.start(),
        unwatch: () => {},
        linger: undefined,
      };
      const selection = client.connectionState();
      created.unwatch = selection.subscribe(() => {
        if (client.state !== "ready") created.generation++;
        for (const member of created.tabs) member.connection();
      });
      this.entries.set(target.key, created);
      entry = created;
    }
    entry.linger?.();
    entry.linger = undefined;
    entry.tabs.add(tab);
    return entry;
  }
  /** @internal */
  forget(tab: Tab): void {
    this.tabs.delete(tab);
  }
  /** @internal */
  part(tab: Tab, entry: Entry): void {
    entry.tabs.delete(tab);
    if (entry.tabs.size) return;
    entry.linger = this.options.scheduler.set(this.options.lingerMs ?? 10_000, () => {
      if (entry.tabs.size) return;
      this.entries.delete(entry.key);
      entry.unwatch();
      void entry.client.close();
    });
  }
  private scheduleSweep(): void {
    if (this.sweep) return;
    const silence = this.options.silenceMs ?? 30_000;
    this.sweep = this.options.scheduler.set(silence / 2, () => {
      this.sweep = undefined;
      const now = this.options.now();
      const hiddenSilence = this.options.hiddenSilenceMs ?? 10 * 60_000;
      // Deleting the current entry while iterating a Set is safe.
      for (const tab of this.tabs) if (tab.silentSince(now, silence, hiddenSilence)) tab.drop();
      if (this.tabs.size) this.scheduleSweep();
    });
  }
}

class Tab {
  lastSeen: number;
  private host: ClientHost;
  private subscriber: string;
  /** File channels and Preview subscriptions, initialized with the first such request. */
  private channels: TabChannels | undefined;
  private loadingChannels: Promise<TabChannels> | undefined;
  private port: PortLike;
  private options: HostOptions;
  private entry: Entry | undefined;
  private leases = new Map<number, Held>();
  private calls = new Map<number, AbortController>();
  private iterators = new Map<number, AsyncGenerator<unknown>>();
  private intents = new Map<string, () => void>();
  private stopPending: (() => void) | undefined;
  private pendingDirty = new Set<string>();
  private pendingReset = false;
  private wantsMessages = false;
  private stopMessages: (() => void) | undefined;
  private visible = true;
  private dropped = false;
  private stopLock: (() => void) | undefined;
  private flushing: (() => void) | undefined;
  private listener = (event: { data: unknown }) => this.receive(event.data);
  constructor(host: ClientHost, port: PortLike, options: HostOptions) {
    this.host = host;
    this.subscriber = host.subscriberId();
    this.port = port;
    this.options = options;
    this.lastSeen = options.now();
    port.addEventListener("message", this.listener);
    port.start?.();
  }
  private post(message: unknown): void {
    if (this.dropped) return;
    try {
      // A MessagePort has no target origin: it reaches exactly the other end.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.port.postMessage(message);
    } catch {
      this.drop();
    }
  }
  /** Whether this tab has been silent too long to be alive; a tab with a lock never is. */
  silentSince(now: number, silence: number, hiddenSilence: number): boolean {
    if (this.stopLock) return false;
    return this.lastSeen < now - (this.visible ? silence : hiddenSilence);
  }
  connection(): void {
    const client = this.entry?.client;
    if (!client) return;
    if (client.state !== "ready") this.channels?.reset();
    this.post({
      t: "connection",
      state: client.state,
      ...(client.error ? { error: errorShape(client.error) } : {}),
    });
  }
  private receive(data: unknown): void {
    this.lastSeen = this.options.now();
    const parsed = TabMessage.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.t === "connect") return this.connect(message.config);
    if (message.t === "ping") return;
    if (message.t === "alive") return this.alive(message.lock);
    if (message.t === "bye") return this.drop();
    if (message.t === "watchMessages") {
      this.wantsMessages = true;
      return this.watchMessages();
    }
    if (message.t === "unwatchMessages") {
      this.wantsMessages = false;
      this.stopMessages?.();
      this.stopMessages = undefined;
      return;
    }
    if (message.t === "visible") {
      this.visible = message.visible;
      if (message.visible) this.schedule();
      return;
    }
    const client = this.entry?.client;
    if (!client) {
      if (message.t === "call" || message.t === "iterate" || message.t === "next")
        this.post({
          t: "failed",
          call: message.call,
          error: errorShape(new ClientError("offline")),
        });
      return;
    }
    switch (message.t) {
      case "lease":
        return this.lease(client, message.lease, message.scope);
      case "release":
        return this.release(message.lease);
      case "call":
        return void this.call(client, message.call, message.method, message.args);
      case "iterate":
        return this.iterate(client, message.call, message.method, message.args);
      case "next":
        return void this.next(message.call);
      case "return":
        return void this.stop(message.call);
      case "abort":
        return this.calls.get(message.call)?.abort();
      case "send":
        return this.sendControl(client, message.message);
      case "watchPendingSends":
        return this.watchPending(client);
      case "unwatchPendingSends":
        this.stopPending?.();
        this.stopPending = undefined;
        this.pendingDirty.clear();
        this.pendingReset = false;
        return;
      case "watchIntent":
        return this.watch(client, message.id);
      case "unwatchIntent":
        this.intents.get(message.id)?.();
        this.intents.delete(message.id);
        return;
    }
  }
  private alive(lock: string): void {
    const watch = this.options.lockReleased;
    if (!watch || this.dropped) return;
    this.stopLock?.();
    this.stopLock = watch(lock, () => this.drop());
  }
  private connect(config: unknown): void {
    let entry: Entry;
    try {
      entry = this.host.join(this, config);
    } catch (error) {
      this.post({ t: "attached", error: errorShape(error) });
      return;
    }
    if (this.entry && this.entry !== entry) {
      this.detach();
      this.host.part(this, this.entry);
    }
    this.entry = entry;
    this.watchMessages();
    entry.started.then(
      () => this.post({ t: "attached", idPrefix: entry.client.commandId() }),
      (error: unknown) => this.post({ t: "attached", error: errorShape(error) }),
    );
    this.connection();
  }
  private lease(client: Client, lease: number, scope: Scope): void {
    if (this.leases.has(lease)) return;
    let held: Held;
    try {
      if (scope.kind === "thread") {
        const subscription = client.thread(scope.threadId);
        const store = subscription.store;
        held = {
          scope,
          release: subscription.release,
          unobserve: () => {},
          read: (keys) => threadPatches(store, keys, held.sent),
          copy: () => store.export(),
          dirty: "all",
          sent: new Map(),
        };
        held.unobserve = store.observe((keys) => this.dirty(held, keys));
      } else {
        const subscription = client.threads();
        const store = subscription.store;
        held = {
          scope,
          release: subscription.release,
          unobserve: () => {},
          read: (keys) => sidebarPatches(store, keys),
          copy: () => store.export(),
          dirty: "all",
          sent: new Map(),
        };
        held.unobserve = store.observe((keys) => this.dirty(held, keys));
      }
    } catch (error) {
      // A lease the client refuses (limits) shows as the store's error in the tab.
      const copy = { error: errorShape(error), view: undefined, truncated: [], ids: [] };
      this.post({ t: "changes", leases: [{ lease, reset: copy }] });
      return;
    }
    this.leases.set(lease, held);
    this.schedule();
  }
  private release(lease: number): void {
    const held = this.leases.get(lease);
    if (!held) return;
    this.leases.delete(lease);
    held.unobserve();
    held.release();
  }
  private dirty(held: Held, keys: ReadonlySet<string> | "all"): void {
    if (keys === "all" || held.dirty === "all") held.dirty = "all";
    else if (held.dirty) for (const key of keys) held.dirty.add(key);
    else held.dirty = new Set(keys);
    if (held.dirty !== "all" && held.dirty.size > backlogKeys) {
      // The next flush sends a whole copy and records what it sent afresh; until then, hold
      // neither the keys nor the items the store has since evicted.
      held.dirty = "all";
      held.sent.clear();
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.flushing || !this.visible) return;
    this.flushing = this.options.scheduler.set(this.options.frameMs ?? 16, () => {
      this.flushing = undefined;
      this.flush();
    });
  }
  private flush(): void {
    if (!this.visible) return;
    this.flushPending();
    const leases: LeaseChanges[] = [];
    for (const [lease, held] of this.leases) {
      const dirty = held.dirty;
      if (!dirty) continue;
      held.dirty = undefined;
      if (dirty === "all") {
        const copy = held.copy();
        held.sent.clear();
        if ("truncated" in copy)
          for (const id of copy.view?.itemOrder ?? []) {
            const item = copy.view?.items[id];
            if (item) held.sent.set(id, item);
          }
        leases.push({ lease, reset: copy });
      } else leases.push({ lease, patches: held.read(dirty) });
    }
    if (leases.length) this.post({ t: "changes", leases });
  }
  private watchPending(client: Client): void {
    if (!this.stopPending)
      this.stopPending = client.observePendingSends((id) => {
        if (!this.pendingReset) {
          this.pendingDirty.add(id);
          if (this.pendingDirty.size > defaultLimits.intents) {
            this.pendingDirty.clear();
            this.pendingReset = true;
          }
        }
        this.schedule();
      });
    this.pendingDirty.clear();
    this.pendingReset = true;
    this.schedule();
  }
  private flushPending(): void {
    const client = this.entry?.client;
    if (!client || !this.stopPending) return;
    if (this.pendingReset) {
      this.pendingReset = false;
      this.pendingDirty.clear();
      this.post({
        t: "pendingSends",
        reset: true,
        entries: client.pendingSends().getSnapshot(),
        removed: [],
      });
      return;
    }
    if (!this.pendingDirty.size) return;
    const entries: PendingSend[] = [];
    const removed: string[] = [];
    for (const id of this.pendingDirty) {
      const entry = client.pendingSend(id);
      if (entry) entries.push(entry);
      else removed.push(id);
    }
    this.pendingDirty.clear();
    this.post({ t: "pendingSends", entries, removed });
  }
  private watch(client: Client, id: string): void {
    if (this.intents.has(id)) return;
    const selection = client.intent(id);
    const send = () => {
      const intent = selection.getSnapshot();
      this.post(intent ? { t: "intent", id, intent } : { t: "intent", id });
    };
    this.intents.set(id, selection.subscribe(send));
    send();
  }
  private watchMessages(): void {
    const client = this.entry?.client;
    if (!client || !this.wantsMessages || this.stopMessages) return;
    try {
      this.stopMessages = client.onMessage((message) => {
        if (isServicePush(message)) this.post({ t: "message", message });
      });
    } catch {
      // At the listener limit the tab misses pushes; its reads still work.
    }
  }
  private async call(client: Client, call: number, method: string, args: unknown[]) {
    const controller = new AbortController();
    this.calls.set(call, controller);
    try {
      const value =
        method === "request" && isChannelRequest(args[0])
          ? await this.channelRequest(client, call, controller, args)
          : await callArgs(client, method, args, controller.signal);
      this.post(value === undefined ? { t: "reply", call } : { t: "reply", call, value });
    } catch (error) {
      this.post({ t: "failed", call, error: errorShape(error) });
    } finally {
      this.calls.delete(call);
    }
  }
  private async channelRequest(
    client: Client,
    call: number,
    controller: AbortController,
    args: unknown[],
  ): Promise<unknown> {
    // The connection a request starts on is fixed before the module loads.
    const entry = this.entry;
    const generation = entry?.generation;
    const channels = this.channels ?? (await this.loadChannels());
    return channels.request({
      client,
      args,
      signal: controller.signal,
      forward: (forwarded) => callArgs(client, "request", forwarded, controller.signal),
      current: () => entry !== undefined && entry.generation === generation,
      pending: () => this.calls.has(call) && !controller.signal.aborted,
    });
  }
  private loadChannels(): Promise<TabChannels> {
    this.loadingChannels ??= loadServiceWire().then(
      (wire) => (this.channels = new TabChannels(this.subscriber, wire)),
      (error: unknown) => {
        // A failed load is retried by the next request rather than remembered.
        this.loadingChannels = undefined;
        throw error;
      },
    );
    return this.loadingChannels;
  }
  /**
   * Pass a tab's one-way control on. File and Preview controls go through the tab's channels;
   * before the tab opened any, none of them is the tab's to send.
   */
  private sendControl(client: Client, value: unknown): void {
    // Only channel controls are decoded here; `sendArgs` decodes every control it passes on.
    const type = objectInput(value).type;
    if (typeof type === "string" && channelControls.has(type)) {
      const control = client.decodeOneWay(value);
      if (control && !this.channels?.admits(control)) return;
    }
    sendArgs(client, value);
  }
  private iterate(client: Client, call: number, method: string, args: unknown[]): void {
    const controller = new AbortController();
    try {
      this.iterators.set(call, iterateArgs(client, method, args, controller.signal));
      this.calls.set(call, controller);
      void this.next(call);
    } catch (error) {
      this.post({ t: "failed", call, error: errorShape(error) });
    }
  }
  private async next(call: number): Promise<void> {
    const iterator = this.iterators.get(call);
    if (!iterator) return;
    try {
      const step = await iterator.next();
      if (step.done) this.finish(call);
      this.post(
        step.done
          ? { t: "yield", call, done: true }
          : { t: "yield", call, done: false, value: step.value },
      );
    } catch (error) {
      this.finish(call);
      this.post({ t: "failed", call, error: errorShape(error) });
    }
  }
  private async stop(call: number): Promise<void> {
    const iterator = this.iterators.get(call);
    this.calls.get(call)?.abort();
    this.finish(call);
    await iterator?.return(undefined).catch(() => {});
  }
  private finish(call: number): void {
    this.iterators.delete(call);
    this.calls.delete(call);
  }
  private detach(): void {
    this.channels?.detach(this.entry?.client);
    for (const lease of this.leases.keys()) this.release(lease);
    for (const stop of this.intents.values()) stop();
    this.intents.clear();
    this.stopPending?.();
    this.stopPending = undefined;
    this.pendingDirty.clear();
    this.pendingReset = false;
    this.stopMessages?.();
    this.stopMessages = undefined;
    for (const controller of this.calls.values()) controller.abort();
    for (const call of this.iterators.keys()) void this.stop(call);
    this.flushing?.();
    this.flushing = undefined;
  }
  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.stopLock?.();
    this.stopLock = undefined;
    this.detach();
    this.port.removeEventListener("message", this.listener);
    this.port.close?.();
    if (this.entry) this.host.part(this, this.entry);
    this.host.forget(this);
    this.entry = undefined;
  }
}

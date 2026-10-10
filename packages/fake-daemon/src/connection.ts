import { sidebarPage, isSidebarEvent } from "@ace/projection";
import {
  ThreadId,
  ClientMessage,
  type Command,
  type CommandResult,
  type DeliveryEvent,
  type HostId,
  type ItemsPage,
  type ServerMessage,
  type ThreadListView,
  type ThreadView,
  type SubscriptionScope,
} from "@ace/protocol";
import type { FakeWireSession } from "./services-wire.ts";

/** What a connection needs from the host. FakeDaemon implements it. */
export interface Host {
  readonly hostId: HostId;
  readonly displayName?: string;
  readonly icon?: import("@ace/protocol").MachineIcon;
  readonly version?: string;
  readonly head: number;
  readonly duplicateEvents: boolean;
  accepts(credential: { token?: string | undefined; ticket?: string | undefined }): boolean;
  snapshot(scope: SubscriptionScope): ThreadView | ThreadListView | undefined;
  replay(scope: SubscriptionScope, afterSeq: number): DeliveryEvent[];
  page(threadId: string, before: number, limit: number): ItemsPage | undefined;
  /** Full shell output for `output.read`; a host without a stream store answers not_found. */
  output?(
    streamId: string,
    offset: number,
    limit: number,
  ): { bytes: Uint8Array; nextOffset: number; eof: boolean } | undefined;
  command(command: Command): CommandResult;
  commandAsync?(command: Command, send?: (message: ServerMessage) => void): Promise<CommandResult>;
  /**
   * Fault injection: "fail" answers a correlated request with the daemon's `unavailable` error,
   * "hold" never answers it (a read that hangs), undefined serves it normally.
   */
  fault?(type: ClientMessage["type"]): "fail" | "hold" | { code: string } | undefined;
  /** Catalog request/response services; false when the message isn't one of them. */
  service(message: ClientMessage, connection: Connection): boolean;
  /** This socket's stateful services (context, terminals, browser, plugins, planning). */
  session(send: (message: ServerMessage) => void): FakeWireSession;
  release(connection: Connection): void;
}
/** The socket half the connection writes to. Delivery is asynchronous, like a real socket. */
export interface Wire {
  send(text: string): void;
  close(code: number): void;
}
interface Subscription {
  scope: SubscriptionScope;
  cursor: number;
  selected?: Set<string>;
  limit?: number;
  before?: import("@ace/protocol").ThreadListCursor | null;
}

export function matches(scope: SubscriptionScope, event: DeliveryEvent): boolean {
  return scope.kind === "threads" ? isSidebarEvent(event) : event.threadId === scope.threadId;
}

/** One client socket speaking the daemon wire protocol (hello, subscriptions, reads, commands). */
export class Connection {
  private host: Host;
  private wire: Wire;
  private session: FakeWireSession;
  private device = "fake";
  private ready = false;
  /** Past `hello`: the daemon's broadcasts reach it. */
  get authenticated(): boolean {
    return this.ready;
  }
  private closed = false;
  private subscriptions = new Map<string, Subscription>();
  /** Service replies and pushes for this socket; stable, so a service can forget it on close. */
  readonly push = (message: ServerMessage): void => this.send(message);
  constructor(host: Host, wire: Wire) {
    this.host = host;
    this.wire = wire;
    this.session = host.session(this.push);
  }
  receive(text: string): void {
    if (this.closed) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.close(4002);
      return;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      this.close(4002);
      return;
    }
    const message = parsed.data;
    if (message.type === "hello") {
      if (!this.host.accepts(message)) {
        this.send({ type: "error", code: "unauthorized", message: "Invalid credential" });
        this.close(4001);
        return;
      }
      this.ready = true;
      this.device = message.deviceId;
      this.session.authenticated?.(this.device);
      this.send({
        type: "welcome",
        hostId: this.host.hostId,
        protocolVersion: 1,
        headSeq: this.host.head,
      });
      return;
    }
    if (!this.ready) {
      this.close(4001);
      return;
    }
    const fault =
      "requestId" in message && message.requestId ? this.host.fault?.(message.type) : undefined;
    if (fault === "hold") return;
    if (fault && "requestId" in message && message.requestId) {
      this.send({
        type: "error",
        requestId: message.requestId,
        code: fault === "fail" ? "unavailable" : fault.code,
        message: "The daemon couldn't answer that right now.",
      });
      return;
    }
    this.handle(message);
  }
  get deviceId(): string {
    return this.device;
  }
  private handle(message: ClientMessage): void {
    switch (message.type) {
      case "host.identity": {
        this.send({
          type: "host.identity.result",
          requestId: message.requestId,
          identity: {
            hostId: this.host.hostId,
            displayName: this.host.displayName ?? "Fake machine",
            icon: this.host.icon ?? { kind: "laptop" },
            version: this.host.version ?? "fake",
          },
        });
        return;
      }
      case "ping":
        this.send({ type: "pong" });
        return;
      case "subscribe":
        this.subscribe(message.subscriptionId, message.scope, message.afterSeq, message.paced);
        return;
      case "threads.page": {
        const subscription = this.subscriptions.get(message.subscriptionId);
        if (
          !subscription ||
          subscription.scope.kind !== "threads" ||
          !subscription.scope.window ||
          !subscription.before ||
          subscription.before.at !== message.before.at ||
          subscription.before.id !== message.before.id
        ) {
          this.error("page_failed", { requestId: message.requestId });
          break;
        }
        const view = this.host.snapshot({ kind: "threads" });
        if (!view || view.kind !== "threads") break;
        const page = sidebarPage(
          Object.values(view.threads),
          subscription.scope.window,
          message.before,
        );
        for (const entry of page.threads) subscription.selected?.add(entry.id);
        subscription.before = page.window.before;
        subscription.limit =
          (subscription.limit ?? subscription.scope.window.limit) + page.threads.length;
        this.send({
          type: "threads.patch",
          requestId: message.requestId,
          subscriptionId: message.subscriptionId,
          seq: this.host.head,
          threads: Object.fromEntries(page.threads.map((entry) => [entry.id, entry])),
          removed: [],
          window: page.window,
        });
        break;
      }
      case "unsubscribe":
        this.subscriptions.delete(message.subscriptionId);
        return;
      case "items.page": {
        const page = this.host.page(message.threadId, message.before, message.limit);
        if (page) this.send({ type: "items.page", requestId: message.requestId, ...page });
        else this.error("not_found", { requestId: message.requestId });
        return;
      }
      case "command": {
        if (
          message.command.payload.type === "thread.markRead" &&
          message.command.deviceId !== this.device
        ) {
          this.send({
            type: "commandResult",
            commandId: message.command.id,
            ok: false,
            error: "forbidden",
          });
          return;
        }
        if (
          (message.command.payload.type === "workspace.clone" ||
            ((message.command.payload.type === "thread.create" ||
              message.command.payload.type === "thread.prepare") &&
              message.command.payload.mode === "worktree")) &&
          this.host.commandAsync
        ) {
          void this.host
            .commandAsync(message.command, this.push)
            .then((result) => this.send({ type: "commandResult", ...result }));
        } else {
          const result = this.host.command(message.command);
          this.send({ type: "commandResult", ...result });
        }
        return;
      }
      case "output.read": {
        const page = this.host.output?.(message.streamId, message.offset, message.limit);
        if (!page) this.error("not_found", { requestId: message.requestId });
        else
          this.send({
            type: "output.data",
            requestId: message.requestId,
            streamId: message.streamId,
            offset: message.offset,
            nextOffset: page.nextOffset,
            bytes: base64(page.bytes),
            eof: page.eof,
          });
        return;
      }
      default:
        if (this.host.service(message, this)) return;
        void this.session.handle(message, this.device);
    }
  }
  private subscribe(
    id: string,
    scope: SubscriptionScope,
    afterSeq: number | undefined,
    paced = false,
  ): void {
    const head = this.host.head;
    if (scope.kind === "threads" && scope.window) {
      const view = this.host.snapshot({ kind: "threads" });
      if (!view || view.kind !== "threads") {
        this.error("not_found", { subscriptionId: id });
        return;
      }
      const page = sidebarPage(Object.values(view.threads), scope.window);
      const threads = Object.fromEntries(page.threads.map((entry) => [entry.id, entry]));
      this.subscriptions.set(id, {
        scope,
        cursor: head,
        selected: new Set(Object.keys(threads)),
        limit: scope.window.limit,
        before: page.window.before,
      });
      this.send({
        type: "snapshot",
        subscriptionId: id,
        seq: head,
        view: { ...view, threads, window: page.window },
      });
      if (paced) this.send({ type: "subscription.ready", subscriptionId: id, seq: head });
      return;
    }
    if (afterSeq !== undefined && afterSeq <= head && this.host.snapshot(scope)) {
      this.subscriptions.set(id, { scope, cursor: head });
      this.deliver(id, afterSeq, head, this.host.replay(scope, afterSeq));
    } else {
      const view = this.host.snapshot(scope);
      if (!view) {
        this.error("not_found", { subscriptionId: id });
        return;
      }
      this.subscriptions.set(id, { scope, cursor: head });
      this.send({ type: "snapshot", subscriptionId: id, seq: view.seq, view });
    }
    // Like the daemon, a paced subscriber learns when initialization (snapshot or replay,
    // even an empty one) is complete, so its startup slot frees for the next scope.
    if (paced) this.send({ type: "subscription.ready", subscriptionId: id, seq: head });
  }
  /** Fan out one appended batch. Filtered events leave a host-sequence gap, as the daemon does. */
  publish(events: readonly DeliveryEvent[], through: number): void {
    for (const [id, subscription] of this.subscriptions) {
      if (
        subscription.scope.kind === "threads" &&
        subscription.scope.window &&
        subscription.selected
      ) {
        if (!events.some(isSidebarEvent)) continue;
        const view = this.host.snapshot({ kind: "threads" });
        if (!view || view.kind !== "threads") continue;
        const options = {
          ...subscription.scope.window,
          limit: subscription.limit ?? subscription.scope.window.limit,
        };
        const current = sidebarPage(Object.values(view.threads), options);
        const changed = new Set(events.filter(isSidebarEvent).map((event) => event.threadId));
        const present = new Map<string, import("@ace/protocol").ThreadListEntry>(
          current.threads.map((entry) => [entry.id, entry]),
        );
        const removed = [...subscription.selected]
          .filter((threadId) => !present.has(threadId))
          .map((threadId) => ThreadId.parse(threadId));
        const rows = current.threads.filter(
          (entry) => changed.has(entry.id) || !subscription.selected?.has(entry.id),
        );
        subscription.selected = new Set(present.keys());
        subscription.before = current.window.before;
        this.send({
          type: "threads.patch",
          subscriptionId: id,
          seq: through,
          threads: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
          removed,
          window: current.window,
        });
        subscription.cursor = through;
        continue;
      }
      const matched = events.filter((event) => matches(subscription.scope, event));
      if (!matched.length) continue;
      this.deliver(id, subscription.cursor, through, matched);
      subscription.cursor = through;
    }
  }
  private deliver(id: string, afterSeq: number, throughSeq: number, events: DeliveryEvent[]) {
    const frame: ServerMessage = {
      type: "events",
      subscriptionId: id,
      afterSeq,
      throughSeq,
      events,
    };
    this.send(frame);
    if (this.host.duplicateEvents) this.send(frame);
  }
  private error(code: string, scope: { requestId?: string; subscriptionId?: string }): void {
    this.send({ type: "error", code, message: code, ...scope });
  }
  private send(message: ServerMessage): void {
    if (!this.closed) this.wire.send(JSON.stringify(message));
  }
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.clear();
    this.session.close();
    this.host.release(this);
    this.wire.close(code);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

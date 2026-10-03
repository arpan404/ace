import { isSidebarEvent } from "@ace/projection";
import {
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

/** What a connection needs from the host. FakeDaemon implements it. */
export interface Host {
  readonly hostId: HostId;
  readonly head: number;
  readonly duplicateEvents: boolean;
  accepts(credential: { token?: string | undefined; ticket?: string | undefined }): boolean;
  snapshot(scope: SubscriptionScope): ThreadView | ThreadListView | undefined;
  replay(scope: SubscriptionScope, afterSeq: number): DeliveryEvent[];
  page(threadId: string, before: number, limit: number): ItemsPage | undefined;
  command(command: Command): CommandResult;
  /** Request/response services; false when the message isn't one the host serves. */
  service(message: ClientMessage, connection: Connection): boolean;
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
}

export function matches(scope: SubscriptionScope, event: DeliveryEvent): boolean {
  return scope.kind === "threads" ? isSidebarEvent(event) : event.threadId === scope.threadId;
}

/** One client socket speaking the daemon wire protocol (hello, subscriptions, reads, commands). */
export class Connection {
  private host: Host;
  private wire: Wire;
  private ready = false;
  private closed = false;
  private subscriptions = new Map<string, Subscription>();
  /** Service replies and pushes for this socket; stable, so a service can forget it on close. */
  readonly push = (message: ServerMessage): void => this.send(message);
  constructor(host: Host, wire: Wire) {
    this.host = host;
    this.wire = wire;
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
    this.handle(message);
  }
  private handle(message: ClientMessage): void {
    switch (message.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "subscribe":
        this.subscribe(message.subscriptionId, message.scope, message.afterSeq);
        return;
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
        const result = this.host.command(message.command);
        this.send({ type: "commandResult", ...result });
        return;
      }
      case "output.read":
        this.error("not_found", { requestId: message.requestId });
        return;
      default:
        if (this.host.service(message, this)) return;
        this.error(
          "unsupported",
          "requestId" in message && typeof message.requestId === "string"
            ? { requestId: message.requestId }
            : {},
        );
    }
  }
  private subscribe(id: string, scope: SubscriptionScope, afterSeq: number | undefined): void {
    const head = this.host.head;
    if (afterSeq !== undefined && afterSeq <= head && this.host.snapshot(scope)) {
      this.subscriptions.set(id, { scope, cursor: head });
      this.deliver(id, afterSeq, head, this.host.replay(scope, afterSeq));
      return;
    }
    const view = this.host.snapshot(scope);
    if (!view) {
      this.error("not_found", { subscriptionId: id });
      return;
    }
    this.subscriptions.set(id, { scope, cursor: head });
    this.send({ type: "snapshot", subscriptionId: id, seq: view.seq, view });
  }
  /** Fan out one appended batch. Filtered events leave a host-sequence gap, as the daemon does. */
  publish(events: readonly DeliveryEvent[], through: number): void {
    for (const [id, subscription] of this.subscriptions) {
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
    this.host.release(this);
    this.wire.close(code);
  }
}

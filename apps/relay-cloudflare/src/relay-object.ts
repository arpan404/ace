import { DurableObject } from "cloudflare:workers";
import { NoiseXX, hostId as hostIdOf, keyPair } from "@ace/secure-channel";
import {
  CONTROL_PROLOGUE,
  HostId,
  LimitsSchema,
  PAIRED_MARKER,
  RelayRoutes,
  Ticket,
} from "@ace/relay/wire";
import type { RouteAction } from "@ace/relay/wire";
import { Attachment, nextExpiry, routeFacts } from "./attachment.ts";
import { openControl, sealControl } from "./control.ts";
import { FrameBudget } from "./frame-budget.ts";
import type { Env } from "./env.ts";
import { refuseUpgrade, upgraded } from "./upgrade.ts";

const limits = LimitsSchema.parse({});
const tag = (id: string) => `socket:${id}`;

function randomTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Handshake = { state: NoiseXX; replied: boolean; timer: ReturnType<typeof setTimeout> };

/**
 * One daemon's relay: its control socket, the clients waiting for it and their paired streams.
 * Every socket hibernates. Nothing here may hold a timer while sockets are idle, or the object
 * is billed for every connected second; the only timer is the handshake deadline.
 */
export class RelayObject extends DurableObject<Env> {
  #routes: RelayRoutes | undefined;
  #handshakes = new Map<string, Handshake>();
  #sockets = new Map<string, WebSocket>();
  #attachments = new WeakMap<WebSocket, Attachment | undefined>();
  #budget = new FrameBudget({ perSecond: limits.messagesPerSecond, burst: limits.messageBurst });

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = crypto.randomUUID();
    const routes = this.#routing();
    const now = Date.now();
    if (url.pathname === "/host") {
      const server = this.#accept(id);
      this.#save(server.socket, {
        kind: "handshake",
        id,
        hostId: HostId.parse(url.searchParams.get("hostId")),
      });
      this.#handshakes.set(id, {
        state: new NoiseXX({
          initiator: false,
          staticKey: keyPair(),
          ephemeralKey: keyPair(),
          prologue: CONTROL_PROLOGUE,
        }),
        replied: false,
        timer: setTimeout(
          () => this.#close(server.socket, 1011, "Handshake timeout"),
          limits.handshakeTimeoutMs,
        ),
      });
      return upgraded(server.client);
    }
    if (url.pathname === "/client") {
      const ticket = randomTicket();
      const actions = routes.request(id, HostId.parse(url.searchParams.get("hostId")), ticket, now);
      const refusal = this.#refusal(actions, id);
      if (refusal) return refusal;
      const server = this.#accept(id);
      const offer = actions.find((action) => action.type === "offer");
      if (offer)
        this.#save(server.socket, {
          kind: "waiting",
          id,
          ticket,
          owner: offer.socket,
          expires: now + limits.ticketTimeoutMs,
        });
      this.#apply(actions);
      if (offer) await this.#scheduleExpiry();
      return upgraded(server.client);
    }
    if (url.pathname === "/join") {
      const actions = routes.join(id, Ticket.parse(url.searchParams.get("ticket")), now);
      const refusal = this.#refusal(actions, id);
      if (refusal) return refusal;
      const server = this.#accept(id);
      this.#apply(actions);
      return upgraded(server.client);
    }
    return refuseUpgrade(1008, "Unknown endpoint");
  }

  /** A hibernatable server socket for an upgrade the relay keeps. */
  #accept(id: string): { client: WebSocket; socket: WebSocket } {
    const [client, socket] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(socket, [tag(id)]);
    this.#sockets.set(id, socket);
    return { client, socket };
  }

  /** Routing that refuses the upgrading socket itself: apply the rest, refuse without hibernation. */
  #refusal(actions: readonly RouteAction[], id: string): Response | undefined {
    const own = actions.find((action) => action.type === "close" && action.socket === id);
    if (own?.type !== "close") return undefined;
    this.#apply(actions.filter((action) => action !== own));
    return refuseUpgrade(own.code, own.reason);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.#read(ws);
    if (!attachment) return this.#close(ws, 1011, "Relay state lost");
    if (typeof message === "string") return this.#close(ws, 1003, "Binary frames required");
    if (message.byteLength > limits.maxFrameSize) return this.#close(ws, 1009, "Frame too large");
    if (!this.#budget.take(attachment.id, Date.now())) return this.#close(ws, 1008, "Rate limit");
    const frame = new Uint8Array(message);
    switch (attachment.kind) {
      case "stream": {
        const peer = this.#socket(attachment.peer);
        if (!peer) return this.#close(ws, 1011, "Peer missing");
        peer.send(frame);
        return;
      }
      case "waiting":
        return this.#apply(this.#routing().premature(attachment.id));
      case "handshake":
        return this.#handshake(ws, attachment, frame);
      case "host": {
        let opened: ReturnType<typeof openControl>;
        try {
          opened = openControl(attachment.receive, frame);
        } catch {
          return this.#close(ws, 1011, "Invalid control message");
        }
        this.#save(ws, { ...attachment, receive: opened.next });
        return this.#apply(this.#routing().reject(attachment.id, opened.message.ticket));
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.#release(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#release(ws);
  }

  override async alarm(): Promise<void> {
    this.#apply(this.#routing().sweep(Date.now()));
    await this.#scheduleExpiry();
  }

  /** Noise XX responder for a daemon's registration, one message per event. */
  #handshake(ws: WebSocket, attachment: Attachment & { kind: "handshake" }, frame: Uint8Array) {
    const pending = this.#handshakes.get(attachment.id);
    if (!pending) return this.#close(ws, 1011, "Handshake lost");
    try {
      if (pending.state.readMessage(frame).length)
        throw new Error("Handshake payload must be empty");
      if (!pending.replied) {
        pending.replied = true;
        ws.send(pending.state.writeMessage());
        return;
      }
    } catch {
      return this.#close(ws, 1011, "Handshake failed");
    }
    clearTimeout(pending.timer);
    this.#handshakes.delete(attachment.id);
    const transport = pending.state.transport;
    try {
      const proven = hostIdOf(transport.remoteStatic);
      // The claimed id only routed this socket here. A key that doesn't own this object's id
      // cannot register; 1008 tells the daemon retrying won't help.
      if (proven !== attachment.hostId) return this.#close(ws, 1008, "Host id mismatch");
      this.#save(ws, {
        kind: "host",
        id: attachment.id,
        hostId: proven,
        send: transport.send.snapshot(),
        receive: transport.receive.snapshot(),
      });
      this.#apply(this.#routing().register(attachment.id, proven));
    } finally {
      transport.destroy();
    }
  }

  #apply(actions: readonly RouteAction[]): void {
    for (const action of actions) {
      if (action.type === "pair") {
        const client = this.#socket(action.client);
        const host = this.#socket(action.host);
        if (!client || !host) {
          if (client) this.#close(client, 1011, "Peer missing");
          if (host) this.#close(host, 1011, "Peer missing");
          continue;
        }
        this.#save(client, { kind: "stream", id: action.client, peer: action.host });
        this.#save(host, { kind: "stream", id: action.host, peer: action.client });
        client.send(new Uint8Array([PAIRED_MARKER]));
        continue;
      }
      const ws = this.#socket(action.socket);
      if (!ws) continue;
      if (action.type === "close") {
        this.#close(ws, action.code, action.reason);
        continue;
      }
      const host = this.#read(ws);
      if (host?.kind !== "host") {
        this.#close(ws, 1011, "Control session missing");
        continue;
      }
      const sealed = sealControl(
        host.send,
        action.type === "registered"
          ? { type: "registered", hostId: action.hostId }
          : { type: "client", ticket: action.ticket },
      );
      this.#save(ws, { ...host, send: sealed.next });
      ws.send(sealed.frame);
    }
  }

  /** Routes live in memory; after hibernation they are rebuilt from socket attachments. */
  #routing(): RelayRoutes {
    if (this.#routes) return this.#routes;
    const routes = new RelayRoutes({ ticketTimeoutMs: limits.ticketTimeoutMs });
    this.#routes = routes;
    const { hosts, pending } = routeFacts(this.#allAttachments());
    this.#apply(routes.restore(hosts, pending));
    return routes;
  }

  async #scheduleExpiry(): Promise<void> {
    const next = nextExpiry(this.#allAttachments());
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  #allAttachments(): Attachment[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const attachment = this.#read(ws);
      return attachment ? [attachment] : [];
    });
  }

  #socket(id: string): WebSocket | undefined {
    const known = this.#sockets.get(id);
    if (known) return known;
    const found = this.ctx.getWebSockets(tag(id))[0];
    if (found) this.#sockets.set(id, found);
    return found;
  }

  #read(ws: WebSocket): Attachment | undefined {
    if (this.#attachments.has(ws)) return this.#attachments.get(ws);
    const raw: unknown = ws.deserializeAttachment();
    const parsed = raw === null ? undefined : Attachment.safeParse(raw).data;
    this.#attachments.set(ws, parsed);
    return parsed;
  }

  #save(ws: WebSocket, attachment: Attachment): void {
    ws.serializeAttachment(attachment);
    this.#attachments.set(ws, attachment);
  }

  #close(ws: WebSocket, code: number, reason: string): void {
    this.#release(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* Already closed. */
    }
  }

  /** Forget a socket once, closing what depended on it: its stream peer or waiting clients. */
  #release(ws: WebSocket): void {
    const attachment = this.#read(ws);
    if (!attachment) return;
    try {
      ws.serializeAttachment(null);
    } catch {
      /* A closed socket keeps no attachment. */
    }
    this.#attachments.set(ws, undefined);
    this.#sockets.delete(attachment.id);
    this.#budget.forget(attachment.id);
    const handshake = this.#handshakes.get(attachment.id);
    if (handshake) {
      clearTimeout(handshake.timer);
      handshake.state.destroy();
      this.#handshakes.delete(attachment.id);
    }
    if (attachment.kind === "stream") {
      const peer = this.#socket(attachment.peer);
      if (peer) this.#close(peer, 1000, "Peer closed");
      return;
    }
    this.#apply(this.#routing().close(attachment.id));
  }
}

import { DurableObject } from "cloudflare:workers";
import { NOT_YOUR_MACHINE_CLOSE } from "@ace/account-grant";
import { NoiseXX, hostId as hostIdOf, keyPair } from "@ace/secure-channel";
import {
  CONTROL_PROLOGUE,
  HTTP_FEATURE,
  HostId,
  LimitsSchema,
  PAIRED_MARKER,
  RelayRoutes,
  Ticket,
} from "@ace/relay/wire";
import type { RouteAction } from "@ace/relay/wire";
import { Attachment, hostAccount, nextExpiry, routeFacts } from "./attachment.ts";
import { ACCOUNT_HEADER, EXCHANGE_HEADER, PROTOCOL_HEADER } from "./admission.ts";
import { machineStore } from "./account/machines.ts";
import { openControl, sealControl } from "./control.ts";
import { FrameBudget } from "./frame-budget.ts";
import { HttpGateway } from "./http-gateway.ts";
import type { Offer } from "./http-gateway.ts";
import { forwardPath } from "./http-path.ts";
import type { Env } from "./env.ts";
import { refuseUpgrade, upgraded } from "./upgrade.ts";

const limits = LimitsSchema.parse({});
/** Closes a registered daemon's control socket so it registers again at once. */
const REGISTER_AGAIN = 4002;
const tag = (id: string) => `socket:${id}`;

function randomTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Handshake = {
  state: NoiseXX;
  replied: boolean;
  timer: ReturnType<typeof setTimeout>;
  /** What the daemon calls itself, for the account's machine list. */
  name: string;
  platform: string;
  /** It serves forwarded HTTP (`features=http`, ADR 0122). */
  http: boolean;
};

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
  #http = new HttpGateway();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Public HTTP for this machine, checked and limited by the Worker (ADR 0122).
    const target = forwardPath(url);
    if (target)
      return this.#http.forward(
        request,
        target,
        request.headers.get(EXCHANGE_HEADER) ?? crypto.randomUUID(),
        (ticket) => this.#offerHttp(target.hostId, ticket),
      );
    if (url.pathname === "/serve")
      return this.#http.join(Ticket.parse(url.searchParams.get("ticket")));
    const id = crypto.randomUUID();
    const routes = this.#routing();
    const now = Date.now();
    // The Worker verified the grant and set these; /join carries none.
    const account = request.headers.get(ACCOUNT_HEADER);
    const protocol = request.headers.get(PROTOCOL_HEADER) ?? undefined;
    const hostId = HostId.parse(url.searchParams.get("hostId"));
    if (url.pathname === "/host") {
      if (!account) return refuseUpgrade(1008, "Account required", protocol);
      const server = this.#accept(id);
      this.#save(server.socket, { kind: "handshake", id, hostId, account });
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
        name: url.searchParams.get("name") ?? "",
        platform: url.searchParams.get("platform") ?? "",
        http: (url.searchParams.get("features") ?? "").split(",").includes(HTTP_FEATURE),
      });
      return upgraded(server.client, protocol);
    }
    if (url.pathname === "/client") {
      if (!account) return refuseUpgrade(1008, "Account required", protocol);
      const owner = hostAccount(this.#allAttachments(), hostId);
      if (owner !== undefined && owner !== account)
        return refuseUpgrade(NOT_YOUR_MACHINE_CLOSE, "Not your machine", protocol);
      const ticket = randomTicket();
      const actions = routes.request(id, hostId, ticket, now);
      const refusal = this.#refusal(actions, id, protocol);
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
      return upgraded(server.client, protocol);
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
  #refusal(actions: readonly RouteAction[], id: string, protocol?: string): Response | undefined {
    const own = actions.find((action) => action.type === "close" && action.socket === id);
    if (own?.type !== "close") return undefined;
    this.#apply(actions.filter((action) => action !== own));
    return refuseUpgrade(own.code, own.reason, protocol);
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
        const { ticket, reason } = opened.message;
        if (this.#http.rejected(ticket, reason)) return;
        return this.#apply(this.#routing().reject(attachment.id, ticket));
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.#read(ws);
    this.#release(ws);
    if (attachment?.kind === "host")
      await machineStore(this.env.ACCOUNTS)
        .seen(attachment.hostId, attachment.account, Date.now())
        .catch(() => {});
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#release(ws);
  }

  override async alarm(): Promise<void> {
    this.#apply(this.#routing().sweep(Date.now()));
    await this.#scheduleExpiry();
  }

  /** Noise XX responder for a daemon's registration, one message per event. */
  async #handshake(
    ws: WebSocket,
    attachment: Attachment & { kind: "handshake" },
    frame: Uint8Array,
  ): Promise<void> {
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
    let host: Attachment & { kind: "host" };
    try {
      const proven = hostIdOf(transport.remoteStatic);
      // The claimed id only routed this socket here. A key that doesn't own this object's id
      // cannot register; 1008 tells the daemon retrying won't help.
      if (proven !== attachment.hostId) return this.#close(ws, 1008, "Host id mismatch");
      host = {
        kind: "host",
        id: attachment.id,
        hostId: proven,
        account: attachment.account,
        send: transport.send.snapshot(),
        receive: transport.receive.snapshot(),
        ...(pending.http ? { http: true } : {}),
      };
    } finally {
      transport.destroy();
    }
    // Two proofs bind the machine to the account: the grant (the session) and the handshake
    // (the key). The directory entry is written before the daemon hears it is registered, so a
    // registered machine is always one the account's devices can find. A failed write ends the
    // registration and the daemon retries.
    try {
      await machineStore(this.env.ACCOUNTS).register(
        {
          hostId: attachment.hostId,
          accountId: attachment.account,
          name: pending.name,
          platform: pending.platform,
        },
        Date.now(),
      );
    } catch {
      return this.#close(ws, 1011, "Directory unavailable");
    }
    // The daemon closed while the entry was written.
    if (this.#read(ws)?.id !== attachment.id) return;
    this.#save(ws, host);
    this.#apply(this.#routing().register(attachment.id, host.hostId));
  }

  /** The caller of forwarded request `exchange` left (the Worker saw it): cancel it. */
  async cancelHttp(exchange: string): Promise<void> {
    this.#http.cancel(exchange);
  }

  /**
   * The account forgot this machine while it is registered here. Its control socket closes with
   * {@link REGISTER_AGAIN}, so the daemon registers again with a fresh grant: still signed in to
   * the account, it is listed again; signed out, the relay refuses it.
   */
  async registerAgain(account: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.#read(ws);
      if (attachment?.kind === "host" && attachment.account === account)
        this.#close(ws, REGISTER_AGAIN, "Register again");
    }
  }

  /** Asks the registered daemon for an HTTP stream, over its control session. */
  #offerHttp(hostId: string, ticket: string): ReturnType<Offer> {
    for (const ws of this.ctx.getWebSockets()) {
      const host = this.#read(ws);
      if (host?.kind !== "host" || host.hostId !== hostId) continue;
      if (!host.http) return "unsupported";
      const sealed = sealControl(host.send, { type: "http", ticket });
      this.#save(ws, { ...host, send: sealed.next });
      try {
        ws.send(sealed.frame);
      } catch {
        return "offline";
      }
      return "sent";
    }
    return "offline";
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

  /**
   * Close `ws` with its own code before releasing it: releasing closes its peer, and the peer's
   * release would otherwise close `ws` first with the peer's "Peer closed".
   */
  #close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* Already closed. */
    }
    this.#release(ws);
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

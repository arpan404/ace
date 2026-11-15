import { HostId, Ticket } from "./config.ts";
import type { RelayPurpose } from "./purpose.ts";
import { EARLY_FRAME } from "./early-frame.ts";
export type RouteAction =
  | { type: "close"; socket: string; code: number; reason: string }
  | { type: "registered"; socket: string; hostId: string }
  | { type: "offer"; socket: string; ticket: string; purpose?: RelayPurpose }
  /** `early`: the client sent a frame before pairing; forward it to `host` right after. */
  | { type: "pair"; client: string; host: string; early?: true };
/** A waiting client's early frame (ADR 0155): room reserved for it, or the frame received. */
export type EarlyState = "reserved" | "held";
type Pending = { client: string; owner: string; expires: number };
/** A client waiting for its host to join, as recorded outside the routes (a socket attachment). */
export type PendingTicket = Pending & { ticket: string; early?: EarlyState };
/** Routing policy has no sockets, randomness or timers. IDs and times enter as facts. */
export class RelayRoutes {
  #hosts = new Map<string, string>();
  /** Host sockets that registered with the `media` feature. */
  #media = new Set<string>();
  #pending = new Map<string, Pending>();
  #waiting = new Set<string>();
  #allowed: ReadonlySet<string> | undefined;
  #ttl: number;
  /** Early-frame reservations by client socket, each counted against its host's socket. */
  #early = new Map<string, { owner: string; state: EarlyState }>();
  constructor(options: { allowedHostIds?: readonly string[]; ticketTimeoutMs: number }) {
    this.#allowed = options.allowedHostIds
      ? new Set(options.allowedHostIds.map((id) => HostId.parse(id)))
      : undefined;
    this.#ttl = options.ticketTimeoutMs;
  }
  /**
   * Rebuild routes from facts recorded before a restart, such as Durable Object socket
   * attachments read after hibernation. A waiting client whose host socket is gone is closed,
   * as if that host had disconnected.
   */
  restore(
    hosts: readonly { socket: string; hostId: string; media?: boolean }[],
    pending: readonly PendingTicket[],
  ): RouteAction[] {
    if (this.#hosts.size || this.#pending.size) throw new Error("Routes already in use");
    for (const host of hosts) {
      HostId.parse(host.hostId);
      if (!this.#allowed || this.#allowed.has(host.hostId)) {
        this.#hosts.set(host.hostId, host.socket);
        if (host.media) this.#media.add(host.socket);
      }
    }
    const owners = new Set(this.#hosts.values());
    const actions: RouteAction[] = [];
    for (const entry of pending) {
      Ticket.parse(entry.ticket);
      if (!owners.has(entry.owner) || this.#pending.has(entry.ticket)) {
        actions.push({
          type: "close",
          socket: entry.client,
          code: 1008,
          reason: "Host disconnected",
        });
        continue;
      }
      // A held frame lived in memory, which a restart lost: that client starts again without
      // sending early. A reservation without a frame still counts.
      if (entry.early === "held") {
        actions.push({
          type: "close",
          socket: entry.client,
          code: EARLY_FRAME.lostClose,
          reason: "Early frame lost",
        });
        continue;
      }
      this.#pending.set(entry.ticket, {
        client: entry.client,
        owner: entry.owner,
        expires: entry.expires,
      });
      this.#waiting.add(entry.client);
      if (entry.early === "reserved")
        this.#early.set(entry.client, { owner: entry.owner, state: "reserved" });
    }
    return actions;
  }
  /** `media`: the host takes media streams (it registered with the `media` feature). */
  register(socket: string, hostId: string, media = false): RouteAction[] {
    HostId.parse(hostId);
    if (this.#allowed && !this.#allowed.has(hostId))
      return [{ type: "close", socket, code: 1008, reason: "Host not allowed" }];
    const previous = this.#hosts.get(hostId);
    this.#hosts.set(hostId, socket);
    if (media) this.#media.add(socket);
    const actions: RouteAction[] = [];
    if (previous && previous !== socket) {
      actions.push(...this.close(previous));
      actions.push({
        type: "close",
        socket: previous,
        code: 4001,
        reason: "Registration replaced",
      });
    }
    actions.push({ type: "registered", socket, hostId });
    return actions;
  }
  /**
   * A client asks for its host. A media stream goes only to a host that takes them; an older
   * daemon would drop its whole registration session on an offer it doesn't know.
   */
  request(
    socket: string,
    hostId: string,
    ticket: string,
    now: number,
    purpose?: RelayPurpose,
  ): RouteAction[] {
    Ticket.parse(ticket);
    const owner = this.#hosts.get(hostId);
    if (!owner || (purpose === "media" && !this.#media.has(owner))) this.#early.delete(socket);
    if (!owner) return [{ type: "close", socket, code: 1008, reason: "Host unavailable" }];
    if (purpose === "media" && !this.#media.has(owner))
      return [{ type: "close", socket, code: 1008, reason: "Media unavailable" }];
    if (this.#pending.has(ticket)) throw new Error("Ticket collision");
    this.#pending.set(ticket, { client: socket, owner, expires: now + this.#ttl });
    this.#waiting.add(socket);
    return [{ type: "offer", socket: owner, ticket, ...(purpose ? { purpose } : {}) }];
  }
  join(socket: string, ticket: string, now: number): RouteAction[] {
    const entry = this.#pending.get(ticket);
    this.#pending.delete(ticket);
    if (entry) this.#waiting.delete(entry.client);
    const held = entry && this.#early.get(entry.client)?.state === "held";
    if (entry) this.#early.delete(entry.client);
    if (!entry || entry.expires <= now)
      return [
        ...(entry
          ? [{ type: "close" as const, socket: entry.client, code: 1008, reason: "Ticket expired" }]
          : []),
        { type: "close", socket, code: 1008, reason: "Invalid ticket" },
      ];
    return [{ type: "pair", client: entry.client, host: socket, ...(held ? { early: true } : {}) }];
  }
  /**
   * Room for one early frame from client `socket` of `hostId`, reserved before its upgrade is
   * accepted (ADR 0155, step 1). False when the host isn't registered or a budget is spent:
   * the client is then not told it may send early, and waits for the marker as before.
   */
  reserveEarly(socket: string, hostId: string): boolean {
    const owner = this.#hosts.get(hostId);
    if (!owner || this.#early.has(socket)) return false;
    let forHost = 0;
    for (const reservation of this.#early.values()) if (reservation.owner === owner) forHost++;
    const relay = this.#early.size;
    if (
      forHost >= EARLY_FRAME.hostFrames ||
      (forHost + 1) * EARLY_FRAME.frameBytes > EARLY_FRAME.hostBytes ||
      relay >= EARLY_FRAME.relayFrames ||
      (relay + 1) * EARLY_FRAME.frameBytes > EARLY_FRAME.relayBytes
    )
      return false;
    this.#early.set(socket, { owner, state: "reserved" });
    return true;
  }
  /** An upgrade that reserved room but never became a waiting client gives it back. */
  releaseEarly(socket: string): void {
    if (!this.#waiting.has(socket)) this.#early.delete(socket);
  }
  /** What client `socket` holds: room for an early frame, the frame, or nothing. */
  earlyState(socket: string): EarlyState | undefined {
    return this.#early.get(socket)?.state;
  }
  /**
   * A frame from client `socket` before it is paired: held when it reserved room and hasn't
   * sent one yet, and no larger than one frame; anything else closes it, as before.
   */
  early(socket: string, bytes: number): RouteAction[] {
    const reservation = this.#early.get(socket);
    if (
      this.#waiting.has(socket) &&
      reservation?.state === "reserved" &&
      bytes <= EARLY_FRAME.frameBytes
    ) {
      reservation.state = "held";
      return [];
    }
    return this.premature(socket);
  }
  reject(owner: string, ticket: string): RouteAction[] {
    const entry = this.#pending.get(ticket);
    if (!entry || entry.owner !== owner) return [];
    this.#pending.delete(ticket);
    this.#waiting.delete(entry.client);
    this.#early.delete(entry.client);
    return [{ type: "close", socket: entry.client, code: 1013, reason: "Host busy" }];
  }
  premature(socket: string): RouteAction[] {
    return this.#waiting.has(socket)
      ? [{ type: "close", socket, code: 1008, reason: "Stream not paired" }]
      : [];
  }
  close(socket: string): RouteAction[] {
    for (const [id, owner] of this.#hosts) if (owner === socket) this.#hosts.delete(id);
    this.#media.delete(socket);
    const actions: RouteAction[] = [];
    this.#waiting.delete(socket);
    this.#early.delete(socket);
    for (const [client, reservation] of this.#early)
      if (reservation.owner === socket) this.#early.delete(client);
    for (const [ticket, entry] of this.#pending) {
      if (entry.client === socket || entry.owner === socket) {
        this.#pending.delete(ticket);
        this.#waiting.delete(entry.client);
        this.#early.delete(entry.client);
        if (entry.client !== socket)
          actions.push({
            type: "close",
            socket: entry.client,
            code: 1008,
            reason: "Host disconnected",
          });
      }
    }
    return actions;
  }
  sweep(now: number): RouteAction[] {
    const actions: RouteAction[] = [];
    for (const [ticket, entry] of this.#pending)
      if (entry.expires <= now) {
        this.#pending.delete(ticket);
        this.#waiting.delete(entry.client);
        this.#early.delete(entry.client);
        actions.push({ type: "close", socket: entry.client, code: 1008, reason: "Ticket expired" });
      }
    return actions;
  }
}

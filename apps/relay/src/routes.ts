import { HostId, Ticket } from "./config.ts";
import type { RelayPurpose } from "./purpose.ts";
export type RouteAction =
  | { type: "close"; socket: string; code: number; reason: string }
  | { type: "registered"; socket: string; hostId: string }
  | { type: "offer"; socket: string; ticket: string; purpose?: RelayPurpose }
  | { type: "pair"; client: string; host: string };
type Pending = { client: string; owner: string; expires: number };
/** A client waiting for its host to join, as recorded outside the routes (a socket attachment). */
export type PendingTicket = Pending & { ticket: string };
/** Routing policy has no sockets, randomness or timers. IDs and times enter as facts. */
export class RelayRoutes {
  #hosts = new Map<string, string>();
  /** Host sockets that registered with the `media` feature. */
  #media = new Set<string>();
  #pending = new Map<string, Pending>();
  #waiting = new Set<string>();
  #allowed: ReadonlySet<string> | undefined;
  #ttl: number;
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
      this.#pending.set(entry.ticket, {
        client: entry.client,
        owner: entry.owner,
        expires: entry.expires,
      });
      this.#waiting.add(entry.client);
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
    if (!entry || entry.expires <= now)
      return [
        ...(entry
          ? [{ type: "close" as const, socket: entry.client, code: 1008, reason: "Ticket expired" }]
          : []),
        { type: "close", socket, code: 1008, reason: "Invalid ticket" },
      ];
    return [{ type: "pair", client: entry.client, host: socket }];
  }
  reject(owner: string, ticket: string): RouteAction[] {
    const entry = this.#pending.get(ticket);
    if (!entry || entry.owner !== owner) return [];
    this.#pending.delete(ticket);
    this.#waiting.delete(entry.client);
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
    for (const [ticket, entry] of this.#pending) {
      if (entry.client === socket || entry.owner === socket) {
        this.#pending.delete(ticket);
        this.#waiting.delete(entry.client);
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
        actions.push({ type: "close", socket: entry.client, code: 1008, reason: "Ticket expired" });
      }
    return actions;
  }
}

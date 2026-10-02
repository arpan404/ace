import { HostId, Ticket } from "./config.ts";
export type RouteAction =
  | { type: "close"; socket: string; code: number; reason: string }
  | { type: "registered"; socket: string; hostId: string }
  | { type: "offer"; socket: string; ticket: string }
  | { type: "pair"; client: string; host: string };
type Pending = { client: string; owner: string; expires: number };
/** Routing policy has no sockets, randomness or timers. IDs and times enter as facts. */
export class RelayRoutes {
  #hosts = new Map<string, string>();
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
  register(socket: string, hostId: string): RouteAction[] {
    HostId.parse(hostId);
    if (this.#allowed && !this.#allowed.has(hostId))
      return [{ type: "close", socket, code: 1008, reason: "Host not allowed" }];
    const previous = this.#hosts.get(hostId);
    this.#hosts.set(hostId, socket);
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
  request(socket: string, hostId: string, ticket: string, now: number): RouteAction[] {
    Ticket.parse(ticket);
    const owner = this.#hosts.get(hostId);
    if (!owner) return [{ type: "close", socket, code: 1008, reason: "Host unavailable" }];
    if (this.#pending.has(ticket)) throw new Error("Ticket collision");
    this.#pending.set(ticket, { client: socket, owner, expires: now + this.#ttl });
    this.#waiting.add(socket);
    return [{ type: "offer", socket: owner, ticket }];
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

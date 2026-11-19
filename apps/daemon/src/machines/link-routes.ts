import type { MachinePath } from "@ace/protocol";

/**
 * Which ways reach a paired machine, and in what order (ADR 0182, ADR 0192), with no I/O. Both
 * parcels and transfers go by this; what each may send on a route is its own rule.
 */

/** One way to reach a paired machine. */
export type MachineRoute =
  | { kind: "direct"; url: string; fingerprint: string; path: "saved" | "lan" | "tailscale" }
  | { kind: "relay"; url: string; relayHostId: string; hosted: boolean };

/** How a call went, for logs: never an address or a credential. */
export type RouteKind = "saved" | "lan" | "tailscale" | "relay" | "account";

export const routeKind = (route: MachineRoute): RouteKind =>
  route.kind === "direct" ? route.path : route.hosted ? "account" : "relay";

/** The route that answered last for a machine, and when. */
export interface PreferredRoute {
  url: string;
  kind: RouteKind;
  at: number;
}

/** A route that answered is tried first for this long, so a dead address isn't waited on each call. */
export const PREFER_MS = 5 * 60 * 1000;

/**
 * The routes to try, best first: the address the machines were linked on, the other direct
 * addresses the machine said it serves (the LAN, Tailscale), the relay they were linked through,
 * then the person's own relay and ace's relay. Loopback is never tried: on this machine it
 * reaches this machine. A direct address must be under the key the link pinned; a machine
 * linked through a relay only pinned none, so it is under the key the machine itself announced
 * on that authenticated stream.
 */
export function machineRoutes(
  saved: {
    origin?: string | undefined;
    fingerprint?: string | undefined;
    relay?: { url: string; relayHostId: string } | undefined;
  },
  paths: readonly MachinePath[],
): MachineRoute[] {
  const routes: MachineRoute[] = [];
  const known = new Set<string>();
  if (saved.origin && saved.fingerprint) {
    routes.push({
      kind: "direct",
      url: saved.origin,
      fingerprint: saved.fingerprint,
      path: "saved",
    });
    known.add(originOf(saved.origin));
  }
  for (const kind of ["lan", "tailscale"] as const)
    for (const path of paths)
      if (
        path.kind === kind &&
        (saved.fingerprint === undefined || path.fingerprint === saved.fingerprint) &&
        !known.has(originOf(path.url))
      ) {
        known.add(originOf(path.url));
        routes.push({ kind: "direct", url: path.url, fingerprint: path.fingerprint, path: kind });
      }
  if (saved.relay) {
    known.add(`relay:${saved.relay.url}`);
    routes.push({
      kind: "relay",
      url: saved.relay.url,
      relayHostId: saved.relay.relayHostId,
      hosted: false,
    });
  }
  for (const kind of ["relay", "account"] as const)
    for (const path of paths)
      if (path.kind === kind && !known.has(`relay:${path.url}`)) {
        known.add(`relay:${path.url}`);
        routes.push({
          kind: "relay",
          url: path.url,
          relayHostId: path.relayHostId,
          hosted: kind === "account",
        });
      }
  return routes;
}

/**
 * `routes` with the one that answered last moved to the front, while it is still preferred at
 * `now`; otherwise unchanged.
 */
export function preferredFirst(
  routes: readonly MachineRoute[],
  preferred: PreferredRoute | undefined,
  now: number,
): MachineRoute[] {
  if (!preferred || now - preferred.at >= PREFER_MS) return [...routes];
  const first = routes.findIndex((route) => route.url === preferred.url);
  const chosen = routes[first];
  if (first <= 0 || !chosen) return [...routes];
  return [chosen, ...routes.slice(0, first), ...routes.slice(first + 1)];
}

function originOf(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? parsed.origin : url;
}

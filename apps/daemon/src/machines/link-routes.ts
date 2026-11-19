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
 * then the other relays it said it is on, the person's own before ace's. Loopback is never tried:
 * on this machine it reaches this machine.
 *
 * What a machine says it serves (`describe`) only adds addresses for a key this side holds
 * (ADR 0192):
 * - a direct address must be under the TLS key the link pinned. A machine linked through a relay
 *   only pinned none, so its addresses are under the one key it announced on that pinned stream;
 *   one announcing two keys gets none of them;
 * - a Tailscale name it announces is never tried: a publicly trusted certificate for a `ts.net`
 *   name passes the pin check without the key (ADR 0097), so such a name proves nothing here;
 * - a relay must be under the relay host key the link pinned. A machine linked on its address only
 *   pinned none, so its relays are under the one key it announced over the pinned TLS link; one
 *   announcing two gets none.
 *
 * Whether a relay is ace's hosted one is this machine's own knowledge (`hosted`), never the label
 * the other machine gave it.
 */
export function machineRoutes(
  saved: {
    origin?: string | undefined;
    fingerprint?: string | undefined;
    relay?: { url: string; relayHostId: string } | undefined;
  },
  paths: readonly MachinePath[],
  hosted: (url: string) => boolean,
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
  const directKey =
    saved.fingerprint ??
    onlyKey(paths, (path) =>
      path.kind === "lan" || path.kind === "tailscale" ? path.fingerprint : undefined,
    );
  for (const kind of ["lan", "tailscale"] as const)
    for (const path of paths)
      if (
        path.kind === kind &&
        directKey !== undefined &&
        path.fingerprint === directKey &&
        !tailnetName(path.url) &&
        !known.has(originOf(path.url))
      ) {
        known.add(originOf(path.url));
        routes.push({ kind: "direct", url: path.url, fingerprint: path.fingerprint, path: kind });
      }
  const relays: MachineRoute[] = [];
  if (saved.relay) {
    known.add(`relay:${saved.relay.url}`);
    routes.push({
      kind: "relay",
      url: saved.relay.url,
      relayHostId: saved.relay.relayHostId,
      hosted: hosted(saved.relay.url),
    });
  }
  const relayKey =
    saved.relay?.relayHostId ??
    onlyKey(paths, (path) =>
      path.kind === "relay" || path.kind === "account" ? path.relayHostId : undefined,
    );
  for (const path of paths)
    if (
      (path.kind === "relay" || path.kind === "account") &&
      relayKey !== undefined &&
      path.relayHostId === relayKey &&
      !known.has(`relay:${path.url}`)
    ) {
      known.add(`relay:${path.url}`);
      relays.push({
        kind: "relay",
        url: path.url,
        relayHostId: path.relayHostId,
        hosted: hosted(path.url),
      });
    }
  // The person's own relays before ace's.
  for (const route of relays) if (route.kind === "relay" && !route.hosted) routes.push(route);
  for (const route of relays) if (route.kind === "relay" && route.hosted) routes.push(route);
  return routes;
}

/** The one key the paths name, or undefined when they name none or more than one. */
function onlyKey(
  paths: readonly MachinePath[],
  key: (path: MachinePath) => string | undefined,
): string | undefined {
  const keys = new Set(paths.flatMap((path) => key(path) ?? []));
  return keys.size === 1 ? [...keys][0] : undefined;
}

/** A Tailscale MagicDNS name, whose public certificate passes a pin check without the key. */
function tailnetName(url: string): boolean {
  const host = URL.parse(url)?.hostname.toLowerCase().replace(/\.$/, "");
  return host !== undefined && host.endsWith(".ts.net");
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

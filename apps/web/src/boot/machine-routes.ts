import {
  isPathKind,
  knownPaths,
  webSocketTransport,
  type MachineRoute,
  type Transport,
} from "@ace/client";
import type { MachinePath, MachinePathKind } from "@ace/protocol";
import { daemonRoute } from "./daemon-route.ts";
import { authorizeDaemonUrl } from "./daemon-network.ts";
import type { DaemonTarget } from "./connection-settings.ts";
import { isLoopbackUrl } from "./fragment-handoff.ts";

type DirectPath = Extract<MachinePath, { kind: "loopback" | "lan" | "tailscale" }>;

/**
 * Whether a browser can prove a direct path reaches the machine (ADR 0114). It can't pin ace's
 * self-signed key, so the LAN and the same computer are out; it can check the publicly trusted
 * certificate Tailscale issues for exactly the ts.net name the machine named (ADR 0097).
 */
export function browserChecksDirect(path: DirectPath): boolean {
  const host = URL.parse(path.url)?.hostname.toLowerCase();
  return path.kind === "tailscale" && !!host?.endsWith(".ts.net");
}

/** The kind of path a paired target's own address is. */
export function targetKind(target: Pick<DaemonTarget, "url" | "relayHostId">): MachinePathKind {
  if (target.relayHostId) return "relay";
  if (isLoopbackUrl(target.url)) return "loopback";
  const host = new URL(target.url).hostname.toLowerCase();
  if (host.endsWith(".ts.net") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host))
    return "tailscale";
  return "lan";
}

/** A paired address as the socket address a worker dials. */
function socketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  return parsed.toString();
}
const origin = (url: string) => new URL(socketUrl(url)).origin;

/** A path a browser can use, with the address it dials. */
type Usable = { kind: MachinePathKind; url: string; relayHostId?: string };

/**
 * Every path a browser can use to a paired machine besides its paired address: what the
 * machine named over a verified connection, that a browser can check. ace's relay admits only
 * account devices, so a paired device never uses it.
 */
function usablePaths(target: DaemonTarget, saved: readonly unknown[] | undefined): Usable[] {
  const seen = new Set([origin(target.url)]);
  const usable: Usable[] = [];
  for (const path of knownPaths(saved)) {
    const url = socketUrl(path.url);
    if (seen.has(origin(url))) continue;
    if (path.kind === "relay") usable.push({ kind: "relay", url, relayHostId: path.relayHostId });
    else if ("fingerprint" in path && browserChecksDirect(path))
      usable.push({ kind: path.kind, url });
    else continue;
    seen.add(origin(url));
  }
  return usable;
}

/**
 * Every path a browser can use to a paired machine, its paired address first. All carry this
 * device's own credential, so its rights are the same on every path (ADR 0114).
 */
export function pairedRoutes(
  target: DaemonTarget,
  saved: readonly unknown[] | undefined,
  clock?: () => number,
): MachineRoute[] {
  const { relayHostId: _relay, ...direct } = target;
  // Direct paths can be probed; relays race on reconnect instead.
  const probe = (url: string) => (clock ? { probe: httpsProbe(url, clock) } : {});
  const routes: MachineRoute[] = [
    {
      path: { key: "paired", kind: targetKind(target) },
      ...daemonRoute(target),
      ...(target.relayHostId ? {} : probe(target.url)),
    },
  ];
  for (const path of usablePaths(target, saved)) {
    const route = daemonRoute(
      path.relayHostId
        ? { ...target, url: path.url, relayHostId: path.relayHostId }
        : { ...direct, url: path.url },
    );
    routes.push({
      path: { key: `${path.kind} ${path.url}`, kind: path.kind },
      ...route,
      ...(path.relayHostId ? {} : probe(path.url)),
    });
  }
  return routes;
}

/**
 * A browser's cheap check of a direct path: two bodiless requests to the daemon's HTTPS
 * listener, which open no ace session. The second reuses the first's connection, so it takes
 * about one round trip, comparable to a ping on the active path. Its certificate is checked
 * by the browser like the path's socket.
 */
export function httpsProbe(url: string, clock: () => number): () => Promise<number> {
  const address = new URL(socketUrl(url));
  address.protocol = address.protocol === "ws:" ? "http:" : "https:";
  address.pathname = "/";
  const once = async () => {
    const started = clock();
    await fetch(address, { method: "HEAD", mode: "no-cors", cache: "no-store" });
    return clock() - started;
  };
  return async () => {
    await authorizeDaemonUrl(url);
    await once();
    return once();
  };
}

/** Every address a pool worker for this machine may dial, for the desktop app to allow. */
export function pairedUrls(target: DaemonTarget, saved: readonly unknown[] | undefined): string[] {
  return [target.url, ...usablePaths(target, saved).map((path) => path.url)];
}

/** The race starts with the path of the kind that won last time. */
export function lastWinnerKey(
  routes: readonly MachineRoute[],
  lastPath: string | undefined,
): string | undefined {
  if (!isPathKind(lastPath)) return undefined;
  return routes.find((route) => route.path.kind === lastPath)?.path.key;
}

/**
 * A socket to a direct path the browser checks itself (`browserChecksDirect`), opened only
 * once the desktop app allows its address.
 */
export function checkedSocketTransport(url: string): Transport {
  const inner = webSocketTransport(() => new WebSocket(socketUrl(url)));
  let closed = false;
  return {
    supportsBinary: true,
    open(events) {
      void authorizeDaemonUrl(url).then(
        () => {
          if (!closed) inner.open(events);
        },
        () => events.close(1006, "Address not allowed"),
      );
    },
    send: (text) => inner.send(text),
    close() {
      closed = true;
      inner.close();
    },
  };
}

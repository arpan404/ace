import type { MachineCallRequest, MachinePath } from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import {
  MachineFailure,
  type MachineTransportOptions,
  type PinnedRequest,
} from "../machines/transport.ts";
import type { ConnectionProfile } from "../machines/connections.ts";
import type { RelayLink } from "./relay-link.ts";
import { parcelRoutes, type ParcelRoute } from "./rules.ts";

export interface ParcelLinkDeps {
  /** One pinned HTTPS request to a direct address (`pinnedRequest`). */
  pinned(
    profile: ConnectionProfile,
    route: PinnedRequest,
    options: MachineTransportOptions,
  ): Promise<unknown>;
  /** Kept-open connections for the address the machine was linked on. */
  connections?: MachineTransportOptions["connections"];
  relay: RelayLink;
  /** The paths the machine last said it serves (`describe`), kept across restarts. */
  paths(profile: RemoteProfile): MachinePath[];
  now(): number;
}

/** A route that answered is tried first for this long, so a dead address isn't waited on each call. */
const PREFER_MS = 5 * 60 * 1000;

/** How a parcel call went, for logs: never an address or a credential. */
export type RouteKind = "saved" | "lan" | "tailscale" | "relay" | "account";

const kindOf = (route: ParcelRoute): RouteKind =>
  route.kind === "direct" ? route.path : route.hosted ? "account" : "relay";

/**
 * Sends a parcel machine call by whatever path reaches the machine (ADR 0182): its linked
 * address, its other direct addresses under the same pinned key, then a relay. Parcel calls are
 * idempotent under their parcel id, so one lost on a path is sent again on the next. A refusal
 * is the machine's answer and is never retried elsewhere.
 */
export class ParcelLink {
  private deps: ParcelLinkDeps;
  private preferred = new Map<string, { kind: RouteKind; url: string; at: number }>();
  constructor(deps: ParcelLinkDeps) {
    this.deps = deps;
  }
  /** The route that answered last for this machine, while it's still preferred. */
  lastRoute(profile: RemoteProfile): RouteKind | undefined {
    const known = this.preferred.get(profile.id);
    return known && this.deps.now() - known.at < PREFER_MS ? known.kind : undefined;
  }
  private order(profile: RemoteProfile): ParcelRoute[] {
    const routes = parcelRoutes(profile, this.deps.paths(profile));
    const known = this.preferred.get(profile.id);
    if (!known || this.deps.now() - known.at >= PREFER_MS) return routes;
    const first = routes.findIndex((route) => route.url === known.url);
    if (first <= 0) return routes;
    const chosen = routes[first];
    return chosen ? [chosen, ...routes.slice(0, first), ...routes.slice(first + 1)] : routes;
  }
  /** The relay answered for this machine last, while that is still preferred. */
  prefersRelay(profile: RemoteProfile): boolean {
    const route = this.lastRoute(profile);
    return route === "relay" || route === "account";
  }
  /**
   * One call through the machine's relays only, for machine calls whose direct attempt never
   * reached it. The same failures as a direct call; none at all is offline.
   */
  async relays(
    profile: RemoteProfile,
    body: MachineCallRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    let last: unknown = new MachineFailure("offline", undefined, "No relay to reach it through");
    for (const route of parcelRoutes(profile, this.deps.paths(profile))) {
      if (route.kind !== "relay") continue;
      options.signal?.throwIfAborted();
      try {
        const answer = await this.once(profile, route, body, options);
        this.preferred.set(profile.id, {
          kind: kindOf(route),
          url: route.url,
          at: this.deps.now(),
        });
        return answer;
      } catch (error) {
        // A refusal is the machine's answer; a call that may have reached it isn't sent again.
        if (error instanceof MachineFailure && error.kind !== "offline") throw error;
        last = error;
      }
    }
    throw last;
  }
  async call(
    profile: RemoteProfile,
    body: MachineCallRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ answer: unknown; route: RouteKind }> {
    let last: unknown = new MachineFailure("offline");
    for (const route of this.order(profile)) {
      options.signal?.throwIfAborted();
      try {
        const answer = await this.once(profile, route, body, options);
        this.preferred.set(profile.id, {
          kind: kindOf(route),
          url: route.url,
          at: this.deps.now(),
        });
        return { answer, route: kindOf(route) };
      } catch (error) {
        if (error instanceof MachineFailure && error.kind === "refused") throw error;
        last = error;
      }
    }
    if (this.preferred.get(profile.id)) this.preferred.delete(profile.id);
    throw last;
  }
  private once(
    profile: RemoteProfile,
    route: ParcelRoute,
    body: MachineCallRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (route.kind === "relay")
      return this.deps.relay.call(
        {
          url: route.url,
          relayHostId: route.relayHostId,
          hosted: route.hosted,
          deviceId: profile.deviceId,
          token: profile.token,
        },
        body,
        options,
      );
    const saved = route.path === "saved";
    return this.deps.pinned(
      { origin: route.url, fingerprint: route.fingerprint, token: profile.token },
      {
        path: "/v1/machine-calls",
        method: "POST",
        body: JSON.stringify(body),
        contentType: "application/json",
        lane: "work",
      },
      {
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        // Only the linked address shares the machine's kept-open connections.
        ...(saved && this.deps.connections ? { connections: this.deps.connections } : {}),
      },
    );
  }
}

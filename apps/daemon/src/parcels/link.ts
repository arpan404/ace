import type { MachineCallRequest, MachinePath } from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import {
  MachineFailure,
  type MachineTransportOptions,
  type PinnedRequest,
} from "../machines/transport.ts";
import type { ConnectionProfile } from "../machines/connections.ts";
import { NoRelayRoute } from "../machines/relay-fallback.ts";
import type { MachineRoute, RouteKind } from "../machines/link-routes.ts";
import { MachineLink } from "../machines/machine-link.ts";
import type { RelayLink } from "../machines/relay-link.ts";

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

/**
 * Sends a parcel machine call by whatever path reaches the machine (ADR 0182): its linked
 * address, its other direct addresses under the same pinned key, then a relay. Parcel calls are
 * idempotent under their parcel id, so one lost on a path is sent again on the next. A refusal
 * is the machine's answer and is never retried elsewhere. Which routes there are and which
 * answered last is `MachineLink`, shared with transfers.
 */
export class ParcelLink {
  private deps: ParcelLinkDeps;
  /** The routes to each machine and which answered last, shared with transfers (ADR 0192). */
  readonly machines: MachineLink;
  constructor(deps: ParcelLinkDeps) {
    this.deps = deps;
    this.machines = new MachineLink({ paths: deps.paths, now: deps.now });
  }
  /** The route that answered last for this machine, while it's still preferred. */
  lastRoute(profile: RemoteProfile): RouteKind | undefined {
    return this.machines.lastRoute(profile);
  }
  /** The relay answered for this machine last, while that is still preferred. */
  prefersRelay(profile: RemoteProfile): boolean {
    return this.machines.prefersRelay(profile);
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
    const { answer } = await this.machines.attempt(profile, this.machines.relays(profile), {
      send: (route) => this.once(profile, route, body, options),
      // A refusal is the machine's answer; a call that may have reached it isn't sent again.
      moveOn: (error) => !(error instanceof MachineFailure && error.kind !== "offline"),
      none: () => new NoRelayRoute("offline", undefined, "No relay to reach it through"),
      signal: options.signal,
    });
    return answer;
  }
  async call(
    profile: RemoteProfile,
    body: MachineCallRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ answer: unknown; route: RouteKind }> {
    try {
      return await this.machines.attempt(profile, this.machines.routes(profile), {
        send: (route) => this.once(profile, route, body, options),
        moveOn: (error) => !(error instanceof MachineFailure && error.kind === "refused"),
        none: () => new MachineFailure("offline"),
        signal: options.signal,
      });
    } catch (error) {
      // Nothing answered on any route: none is preferred any more.
      if (
        !(error instanceof MachineFailure && error.kind === "refused") &&
        !options.signal?.aborted
      )
        this.machines.forget(profile);
      throw error;
    }
  }
  private once(
    profile: RemoteProfile,
    route: MachineRoute,
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

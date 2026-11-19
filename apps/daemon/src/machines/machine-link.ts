import type { MachinePath } from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import {
  PREFER_MS,
  machineRoutes,
  preferredFirst,
  routeKind,
  type MachineRoute,
  type PreferredRoute,
  type RouteKind,
  type EnrolledPins,
} from "./link-routes.ts";

export interface MachineLinkDeps {
  /** The paths the machine last said it serves (`describe`), kept across restarts. */
  paths(profile: RemoteProfile): MachinePath[];
  /** Whether a relay address is ace's hosted relay, as this machine's own settings name it. */
  hosted(url: string): boolean;
  /** Keys this pairing enrolled after it was made (`enrollPins`); none when absent. */
  pins?(profile: RemoteProfile): EnrolledPins;
  now(): number;
}

/** What one attempt over the routes is told. */
export interface RouteAttempt<T> {
  /** One try on one route. */
  send(route: MachineRoute): Promise<T>;
  /**
   * Whether a try that failed with `error` goes on to the next route. A refusal is the machine's
   * answer and never does; what else may is the caller's rule (ADR 0192).
   */
  moveOn(error: unknown): boolean;
  /** What is thrown when no route was tried at all. */
  none(): unknown;
  signal?: AbortSignal | undefined;
}

/**
 * The ways to one paired machine and which answered last (ADR 0182, ADR 0192): parcels and
 * transfers both go through this, so a route one of them found is tried first by the other.
 * It sends nothing itself; each caller says how one try goes and which failures move on.
 */
export class MachineLink {
  private deps: MachineLinkDeps;
  private preferred = new Map<string, PreferredRoute>();
  constructor(deps: MachineLinkDeps) {
    this.deps = deps;
  }
  /** The route that answered last for this machine, while it's still preferred. */
  lastRoute(profile: RemoteProfile): RouteKind | undefined {
    const known = this.preferred.get(profile.id);
    return known && this.deps.now() - known.at < PREFER_MS ? known.kind : undefined;
  }
  /** A relay answered for this machine last, while that is still preferred. */
  prefersRelay(profile: RemoteProfile): boolean {
    const route = this.lastRoute(profile);
    return route === "relay" || route === "account";
  }
  /** Every route to the machine, the one that answered last first. */
  routes(profile: RemoteProfile): MachineRoute[] {
    return preferredFirst(
      machineRoutes(profile, this.deps.paths(profile), this.deps.hosted, this.deps.pins?.(profile)),
      this.preferred.get(profile.id),
      this.deps.now(),
    );
  }
  /** Its relays only, in their own order. */
  relays(profile: RemoteProfile): MachineRoute[] {
    return machineRoutes(
      profile,
      this.deps.paths(profile),
      this.deps.hosted,
      this.deps.pins?.(profile),
    ).filter((route) => route.kind === "relay");
  }
  /** Nothing answered on any route: none is preferred any more. */
  forget(profile: RemoteProfile): void {
    this.preferred.delete(profile.id);
  }
  /**
   * Tries `routes` in order until one answers, which is then preferred. A failure the caller
   * doesn't move on from is thrown as it is; past the last route, the last failure is.
   */
  async attempt<T>(
    profile: RemoteProfile,
    routes: readonly MachineRoute[],
    attempt: RouteAttempt<T>,
  ): Promise<{ answer: T; route: RouteKind }> {
    let last: unknown;
    let tried = false;
    for (const route of routes) {
      attempt.signal?.throwIfAborted();
      tried = true;
      try {
        const answer = await attempt.send(route);
        this.preferred.set(profile.id, {
          kind: routeKind(route),
          url: route.url,
          at: this.deps.now(),
        });
        return { answer, route: routeKind(route) };
      } catch (error) {
        if (!attempt.moveOn(error)) throw error;
        last = error;
      }
    }
    throw tried ? last : attempt.none();
  }
}

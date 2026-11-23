import type { PairedStanding, StandingRoute } from "./socket.ts";

/** What the phone's sockets to one machine have each proven, and which one counts now. */
export interface ActiveStanding {
  readonly state: PairedStanding;
  readonly route: StandingRoute;
}

/**
 * The verdicts of the sockets to one machine, each kept with the socket it came from. The
 * newest verdict is the active one, so an older socket closing never clears what a newer
 * socket on another route proved. Pure.
 */
export class StandingBook {
  private readonly held = new Map<string, ActiveStanding>();

  /** A socket's verdict, or `undefined` when it no longer holds. */
  set(socket: string, state: PairedStanding | undefined, route: StandingRoute): void {
    this.held.delete(socket);
    if (state) this.held.set(socket, { state, route });
  }

  active(): ActiveStanding | undefined {
    return [...this.held.values()].at(-1);
  }

  clear(): void {
    this.held.clear();
  }
}

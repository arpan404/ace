import { DeviceRevokedClose } from "@ace/protocol";
import { disconnectDecision } from "./lifecycle.ts";
import type { PathRoute } from "./path-handshake.ts";
import { pathTiming, type PlannedPath } from "./path-plan.ts";
import type { Scheduler, Transport, TransportEvents } from "./types.ts";

/** One path to the machine, as a platform can dial it with every check it needs. */
export interface MachineRoute extends PathRoute {
  path: PlannedPath;
  /**
   * A cheap check of this path that opens no session (a pinned TLS handshake, or the relay's
   * socket), resolving with its round trip in ms. Without one, the path is never probed: it is
   * used in races and failovers only.
   */
  probe?(): Promise<number>;
}

export interface RaceOptions {
  /** The paths to try, in order: the first starts at once, each next 150 ms later. */
  routes: readonly MachineRoute[];
  scheduler: Scheduler;
  /** `route` opened first: the connection says hello on it with that route's credential. */
  won(route: MachineRoute): void;
  /** `route` failed before any path won. */
  failed(route: MachineRoute): void;
}

/** A refusal another attempt can't change, on that path at least. */
const final = (code: number) => disconnectDecision(true, true, code) === "fatal";
/** The owner revoked this device: true on every path. */
const isRevocation = ([code, reason]: [number, string]) =>
  DeviceRevokedClose.safeParse({ code, reason }).success;

/**
 * One connection attempt over every path at once, happy-eyeballs style (ADR 0114): the first
 * path starts at once and each next one 150 ms after, or as soon as the one before it fails.
 * The first to open its secure transport (a pinned TLS socket, or a relay's pinned handshake)
 * carries the attempt; the rest close. When every path fails, the attempt closes as a drop, and
 * a refusal one path heard (a 4xxx close, such as the relay's "Not your machine") is the drop's
 * reason, so the person sees why while it retries: another path may work from elsewhere. Only
 * when every path was refused does the attempt close with the refusal itself, and the owner's
 * revocation of the device, which holds on every path, always does.
 */
export function racingTransport(options: RaceOptions): Transport {
  let winner: Transport | undefined;
  let winningRoute: MachineRoute | undefined;
  let closed = false;
  const started: { route: MachineRoute; transport: Transport; failed: boolean }[] = [];
  let cancelNext: (() => void) | undefined;
  const closeAll = (keep?: Transport) => {
    cancelNext?.();
    cancelNext = undefined;
    for (const entry of started)
      if (entry.transport !== keep)
        try {
          entry.transport.close();
        } catch {
          /* Already gone. */
        }
  };
  return {
    get supportsBinary() {
      return winner?.supportsBinary === true;
    },
    get compression() {
      return winner?.compression ?? [];
    },
    get flowControl() {
      return winner?.flowControl ?? [];
    },
    // The winning path's own credential: its transport's, else its route's.
    credential() {
      if (!winner || !winningRoute) return Promise.reject(new Error("No path is open"));
      return winner.credential?.() ?? winningRoute.credential();
    },
    open(events: TransportEvents) {
      let next = 0;
      /** The refusal paths closed with before any path won: a final one is never replaced. */
      let refusal: [number, string] | undefined;
      /** A path ended without a refusal: unreachable, dropped, or not dialable. */
      let dropped = false;
      const refused = (code: number, reason: string) => {
        if (refusal && (isRevocation(refusal) || (final(refusal[0]) && !final(code)))) return;
        refusal = [code, reason];
      };
      const revoked = () => refusal !== undefined && isRevocation(refusal);
      const exhausted = () =>
        !winner && next >= options.routes.length && started.every((entry) => entry.failed);
      const lost = () => {
        if (!closed && exhausted()) {
          closed = true;
          if (refusal && (!dropped || revoked())) events.close(...refusal);
          else events.close(1006, refusal?.[1] || "No path answered");
        }
      };
      const start = () => {
        cancelNext = undefined;
        if (winner || closed) return;
        const route = options.routes[next++];
        if (!route) {
          lost();
          return;
        }
        let transport: Transport;
        try {
          transport = route.transport();
        } catch {
          dropped = true;
          options.failed(route);
          start();
          return;
        }
        const entry = { route, transport, failed: false };
        started.push(entry);
        const fail = (code?: number, reason?: string) => {
          if (entry.failed || winner === transport) return;
          if (code !== undefined && code >= 4000) refused(code, reason ?? "");
          else dropped = true;
          entry.failed = true;
          options.failed(route);
          // A path that fails fast lets the next one start without waiting out its stagger.
          if (!winner && cancelNext) {
            cancelNext();
            start();
          } else lost();
        };
        transport.open({
          open: () => {
            if (winner || closed) {
              if (winner !== transport) transport.close();
              return;
            }
            winner = transport;
            winningRoute = route;
            closeAll(transport);
            options.won(route);
            events.open();
          },
          message: (text) => {
            if (winner === transport) events.message(text);
          },
          binary: (bytes) => {
            if (winner === transport) events.binary?.(bytes);
          },
          close: (code, reason) => {
            if (winner === transport) events.close(code, reason);
            else fail(code, reason);
          },
        });
        if (!winner && next < options.routes.length)
          cancelNext = options.scheduler.set(pathTiming.raceStaggerMs, start);
      };
      if (!options.routes.length) {
        closed = true;
        events.close(1006, "No path to this machine");
        return;
      }
      start();
    },
    send(text) {
      if (!winner) throw new Error("No path is open");
      winner.send(text);
    },
    close() {
      closed = true;
      closeAll();
    },
  };
}

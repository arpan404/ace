import { browserReadSnapshots } from "./read-snapshots.ts";
import { daemonRoute } from "./daemon-route.ts";
import { ClientCore, Multipath } from "@ace/client";
import { lastWinnerKey, pairedRoutes } from "./machine-routes.ts";
import { ClientHost, type PortLike } from "@ace/client-worker";
import { HostId } from "@ace/protocol";
import { browserClientOptions } from "./client.ts";
import { workerOutbox } from "./worker-outbox.ts";
import { MachineTarget } from "./machine-target.ts";

/*
 * Entry of a machine-pool worker (ADR 0059): a dedicated Worker for one of the person's other
 * machines, never shared with another machine or with the tabs' `client-worker.ts`. Its client
 * is pinned to the machine's host id, so a daemon answering as another host is refused before
 * any durable command or subscription replays. Kept apart from `client-worker.ts`, which serves
 * this window's own daemon, so neither carries the other's code.
 */

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

const host = new ClientHost({
  target(config) {
    const target = MachineTarget.parse(config);
    return {
      key: target.hostId,
      create: () => {
        // A machine with other paths moves between them (ADR 0114); one with none dials its
        // paired address as before.
        const routes = pairedRoutes(target, target.paths);
        const paths =
          routes.length > 1
            ? new Multipath({
                routes: () => routes,
                scheduler: timers,
                now: () => Date.now(),
                clock: () => performance.now(),
                lastWinner: lastWinnerKey(routes, target.lastPath),
              })
            : undefined;
        const client = new ClientCore({
          ...browserClientOptions({
            deviceId: target.deviceId,
            ...(paths ? paths.route() : daemonRoute(target)),
            storage: workerOutbox(target),
            readSnapshots: browserReadSnapshots(target),
          }),
          expectedHostId: HostId.parse(target.hostId),
        });
        if (paths) {
          client.usePaths(paths);
          // The network changed: a better path may be back, or the active one gone.
          addEventListener("online", () => paths.networkChanged());
        }
        return client;
      },
    };
  },
  scheduler: timers,
  now: () => Date.now(),
});

const scope: unknown = globalThis;
const isPort = (value: unknown): value is PortLike =>
  typeof value === "object" && value !== null && "postMessage" in value;
if (isPort(scope)) host.attach(scope);

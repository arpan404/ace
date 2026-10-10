import { browserCredential } from "./remote-credential.ts";
import { ClientCore, webSocketTransport } from "@ace/client";
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

const host = new ClientHost({
  target(config) {
    const target = MachineTarget.parse(config);
    return {
      key: target.hostId,
      create: () =>
        new ClientCore({
          ...browserClientOptions({
            deviceId: target.deviceId,
            transport: () => webSocketTransport(() => new WebSocket(target.url)),
            credential: browserCredential(target),
            storage: workerOutbox(target),
          }),
          expectedHostId: HostId.parse(target.hostId),
        }),
    };
  },
  scheduler: {
    set(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  },
  now: () => Date.now(),
});

const scope: unknown = globalThis;
const isPort = (value: unknown): value is PortLike =>
  typeof value === "object" && value !== null && "postMessage" in value;
if (isPort(scope)) host.attach(scope);

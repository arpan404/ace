import { ClientHost, type PortLike } from "@ace/client-worker";
import { webSocketTransport } from "@ace/client";
import { createBrowserClient } from "./client.ts";
import { idbOutbox } from "./idb-storage.ts";
import { WorkerTarget, outboxKey } from "./worker-target.ts";

/*
 * Entry of the client worker (ADR 0050): a SharedWorker serving every tab of this origin, or a
 * dedicated Worker per tab where SharedWorker is missing. It owns the socket, frame decoding,
 * projection and the intents outbox; tabs hold mirrors of the stores they read.
 */

const host = new ClientHost({
  target(config) {
    const target = WorkerTarget.parse(config);
    return {
      // Tabs reaching the same daemon as the same device share one client and one socket.
      key: `${outboxKey(target)}\u0000${target.token}`,
      create: () =>
        createBrowserClient({
          deviceId: target.deviceId,
          transport: () => webSocketTransport(() => new WebSocket(target.url)),
          credential: async () => target.token,
          storage: idbOutbox(outboxKey(target), target.seed),
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

interface ConnectEvent {
  ports: readonly PortLike[];
}
const isConnectEvent = (event: unknown): event is ConnectEvent =>
  typeof event === "object" && event !== null && "ports" in event && Array.isArray(event.ports);
const isPort = (scope: unknown): scope is PortLike =>
  typeof scope === "object" && scope !== null && "postMessage" in scope;

const scope: unknown = globalThis;
if (typeof scope === "object" && scope !== null && "onconnect" in scope)
  addEventListener("connect", (event: unknown) => {
    if (isConnectEvent(event)) for (const port of event.ports) host.attach(port);
  });
else if (isPort(scope)) host.attach(scope);

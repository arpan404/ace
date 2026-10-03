import { ClientHost, type PortLike } from "@ace/client-worker";
import { SoakDaemon, fakeTransport } from "@ace/fake-daemon";
import { z } from "zod";
import { createBrowserClient, memoryStorage } from "./client.ts";

/*
 * `vite --mode perf` only: the client worker of a real browser build, fed by an endless agent
 * streaming at a fixed rate (tools/web-perf measures input latency and long tasks against it).
 * Everything after the transport is the production path: decode, projection, patches, UI.
 */

const Config = z.object({ rate: z.number().int().positive().max(100_000) });
const daemon = new SoakDaemon({ clock: () => Date.now() });
let pumping = false;

function pump(rate: number, report: (events: number) => void): void {
  if (pumping) return;
  pumping = true;
  let owed = 0;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    owed += ((now - last) * rate) / 1000;
    last = now;
    const due = Math.floor(owed);
    owed -= due;
    if (due > 0) daemon.pump(due, 64);
    report(daemon.events);
  }, 8);
}

const scope: unknown = globalThis;
const isPort = (value: unknown): value is PortLike =>
  typeof value === "object" && value !== null && "postMessage" in value;
if (isPort(scope)) {
  const port = scope;
  const host = new ClientHost({
    target(config) {
      const { rate } = Config.parse(config);
      return {
        key: "perf",
        create: () => {
          const client = createBrowserClient({
            deviceId: "web-perf-device",
            transport: () => fakeTransport(daemon),
            credential: async () => daemon.token,
            storage: memoryStorage(),
          });
          // Stream once the tab is attached and following the thread.
          setTimeout(
            () =>
              pump(rate, (events) =>
                // A dedicated worker answers its own page; there is no target origin.
                // oxlint-disable-next-line unicorn/require-post-message-target-origin
                port.postMessage({ t: "perf", events }),
              ),
            1_000,
          );
          return client;
        },
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
  host.attach(port);
}

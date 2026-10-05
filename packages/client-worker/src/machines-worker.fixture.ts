/** Real isolated worker fixture. Every provider effect is served by the in-memory fake. */
import { parentPort, workerData } from "node:worker_threads";
import { Client, type Scheduler, type Transport } from "@ace/client";
import { FakeDaemon, fakeTransport, facts } from "@ace/fake-daemon";
import { DeviceId, HostId, ServerMessage } from "@ace/protocol";
import { z } from "zod";
import { ClientHost } from "./host.ts";

const config = z
  .object({
    hostId: z.string(),
    name: z.string(),
    token: z.string(),
    sidebarFault: z.enum(["hold", "fail"]).optional(),
    gate: z.instanceof(SharedArrayBuffer),
    threadCount: z.number().int().min(1).max(1000).optional(),
  })
  .parse(workerData);
const daemon = new FakeDaemon({
  clock: () => 1000,
  hostId: config.hostId,
  displayName: config.name,
  token: "a".repeat(64),
  catalog: {
    accounts: [
      {
        id: config.hostId,
        provider: "codex",
        label: config.name,
        availability: "available",
        quota: { auth: "logged_in", observedAt: 1000, windows: {}, blockers: {}, usage: {} },
      },
    ],
  },
});
daemon.createThread({
  id: "shared",
  workspaceId: "project",
  title: config.name,
  provider: "codex",
});
daemon.apply("shared", [facts.rootAgent("codex")]);
for (let i = 1; i < (config.threadCount ?? 1); i++)
  daemon.createThread({
    id: `seed-${i}`,
    workspaceId: "project",
    title: `Seed ${i}`,
    provider: "codex",
  });
const scheduler: Scheduler = {
  set(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
let sequence = 0;
let sidebarFault = config.sidebarFault;
let releaseSidebar: (() => void) | undefined;
/** Faults at the transport boundary, including uncorrelated subscription snapshots. */
function transport(): Transport {
  const base = fakeTransport(daemon);
  return {
    ...base,
    open(events) {
      base.open({
        ...events,
        message(text) {
          const message = ServerMessage.parse(JSON.parse(text));
          if (message.type === "snapshot" && message.view.kind === "threads" && sidebarFault) {
            if (sidebarFault === "hold") releaseSidebar = () => events.message(text);
            else
              events.message(
                JSON.stringify({
                  type: "error",
                  code: "unavailable",
                  message: "Snapshot unavailable",
                  subscriptionId: message.subscriptionId,
                }),
              );
            return;
          }
          events.message(text);
        },
      });
    },
  };
}
const host = new ClientHost({
  target() {
    return {
      key: config.hostId,
      create: () =>
        new Client({
          deviceId: DeviceId.parse("device"),
          expectedHostId: HostId.parse(config.hostId),
          credential: async () => config.token,
          transport,
          storage: { load: async () => null, save: async () => {} },
          scheduler,
          random: () => 0,
          id: () => `${config.hostId}-${++sequence}`,
          limits: {
            retryBaseMs: 10,
            retryCapMs: 20,
            heartbeatMs: 10000,
          },
        }),
    };
  },
  scheduler,
  now: () => performance.now(),
  frameMs: 1,
  lingerMs: 0,
});
const port = parentPort;
if (!port) throw new Error("Missing parent port");
const control = z.object({
  control: z.enum(["offline", "online", "block", "hold", "release", "release-sidebar"]),
  id: z.number(),
});
port.on("message", (data: unknown) => {
  const parsed = control.safeParse(data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.control === "offline") daemon.refuseConnections(true);
  if (message.control === "online") daemon.refuseConnections(false);
  if (message.control === "hold") daemon.holdRequests("host.identity");
  if (message.control === "release") daemon.restoreRequests();
  if (message.control === "release-sidebar") {
    sidebarFault = undefined;
    releaseSidebar?.();
    releaseSidebar = undefined;
  }
  port.postMessage({ controlAck: message.id });
  if (message.control === "block") Atomics.wait(new Int32Array(config.gate), 0, 0);
});
host.attach({
  postMessage(value) {
    port.postMessage(value);
  },
  addEventListener(_type, listener) {
    port.on("message", (data: unknown) => listener({ data }));
  },
  removeEventListener() {},
});

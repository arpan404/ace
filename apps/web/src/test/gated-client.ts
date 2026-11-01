import { Client, type Limits, type ReadSnapshotStorage, type TransportEvents } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";

/** Read snapshots kept in memory, so a later client of the same test can paint from them. */
export function memoryReadSnapshots(): ReadSnapshotStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}

/** While `held`, the daemon's view snapshots (and what follows them on their wire) wait in `queue`. */
export interface Gate {
  held: boolean;
  queue: (() => void)[];
  /** Also hold every frame of a subscription that started while held, replays included. */
  newWires?: boolean;
  /** Each thread's latest subscription, by thread id, from the snapshots that came through. */
  subscriptions?: Map<string, string>;
  /** Hand the client a frame as if the daemon sent it, once the connection is open. */
  deliver?: (text: string) => void;
}

/** A client over `daemon` that keeps read snapshots in `saved`, its snapshots behind `gate`. */
export function gatedClient(
  daemon: FakeDaemon,
  saved: ReadSnapshotStorage,
  gate?: Gate,
  limits?: Partial<Limits>,
): Client {
  let ids = 0;
  return new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => (gate ? holding(daemon, gate) : fakeTransport(daemon)),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    readSnapshots: saved,
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
    limits: { retryBaseMs: 2, retryCapMs: 10, ...limits },
  });
}

function holding(daemon: FakeDaemon, gate: Gate) {
  const inner = fakeTransport(daemon);
  const wires = new Set<string>();
  const flowing = new Set<string>();
  return {
    open(events: TransportEvents) {
      gate.deliver = (text) => events.message(text);
      inner.open({
        open: () => events.open(),
        close: (code, reason) => events.close(code, reason),
        message(text) {
          const frame: unknown = JSON.parse(text);
          const wire =
            typeof frame === "object" && frame !== null && "subscriptionId" in frame
              ? frame.subscriptionId
              : undefined;
          const snapshot =
            typeof frame === "object" &&
            frame !== null &&
            "type" in frame &&
            frame.type === "snapshot";
          const fresh = typeof wire === "string" && gate.newWires === true && !flowing.has(wire);
          if (gate.held && typeof wire === "string" && (snapshot || wires.has(wire) || fresh)) {
            wires.add(wire);
            gate.queue.push(() => events.message(text));
            return;
          }
          if (typeof wire === "string") flowing.add(wire);
          const viewed = snapshot && typeof wire === "string" ? threadOf(frame) : undefined;
          if (viewed && typeof wire === "string") gate.subscriptions?.set(viewed, wire);
          events.message(text);
        },
      });
    },
    send: (text: string) => inner.send(text),
    close: () => inner.close(),
  };
}

/** The thread a snapshot frame is of, read without trusting its shape. */
function threadOf(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null || !("view" in frame)) return undefined;
  const view = frame.view;
  if (typeof view !== "object" || view === null || !("thread" in view)) return undefined;
  const thread = view.thread;
  if (typeof thread !== "object" || thread === null || !("id" in thread)) return undefined;
  return typeof thread.id === "string" ? thread.id : undefined;
}

/**
 * The real client (packages/client) as a paired phone runs it, pointed through a link shaper:
 * either the daemon's pinned TLS listener with a fresh socket ticket per attempt, or the relay
 * with the device token in its hello. Its read snapshots live in a file-backed store, so a
 * second client on the same file starts from what the first kept on disk.
 */
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client, relayRoute, ticketCredential, type ReadSnapshotStorage } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { accessRequest, pinnedSocketTransport } from "@ace/daemon/client-access";
import { DeviceId } from "@ace/protocol";
import { z } from "zod";
import { countsSince, type LinkCounts, type LinkShaper } from "@ace/perf-kit/link";

export type LinkPath = "direct" | "relay";

export interface Route {
  path: LinkPath;
  shaper: LinkShaper;
  deviceId: string;
  token: string;
  fingerprint: string;
  /** The relay's own address, whose host and port the shaper stands in for. */
  relayUrl?: string;
  relayHostId?: string;
}

const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * Read snapshots and the daemon's bound identity in memory, written to and read from one JSON
 * file, as an app keeps them between launches. Records are filed under the bound host, so a
 * client paints from disk before it connects only when it remembers which daemon it was.
 */
export class FileSnapshots implements ReadSnapshotStorage {
  readonly records = new Map<string, unknown>();
  readonly file: string;
  host: string | null = null;
  constructor(file: string) {
    this.file = file;
  }
  async load(): Promise<void> {
    const text = await readFile(this.file, "utf8").catch(() => "{}");
    const saved = z
      .object({
        host: z.string().nullable().default(null),
        records: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(JSON.parse(text));
    this.host = saved.host;
    for (const [key, value] of Object.entries(saved.records)) this.records.set(key, value);
  }
  async save(): Promise<number> {
    const text = JSON.stringify({ host: this.host, records: Object.fromEntries(this.records) });
    await writeFile(this.file, text);
    return text.length;
  }
  async get(key: string) {
    return structuredClone(this.records.get(key));
  }
  async set(key: string, value: unknown) {
    this.records.set(key, JSON.parse(JSON.stringify(value)));
  }
  async clear() {
    this.records.clear();
  }
  async delete(key: string) {
    this.records.delete(key);
  }
  async deletePrefix(prefix: string) {
    for (const key of [...this.records.keys()])
      if (key.startsWith(prefix)) this.records.delete(key);
  }
}

export function shapedClient(route: Route, snapshots: FileSnapshots): Client {
  const base = {
    deviceId: DeviceId.parse(route.deviceId),
    storage: {
      load: async () => null,
      save: async () => {},
      hostBinding: {
        load: async () => snapshots.host,
        save: async (host: string) => {
          snapshots.host = host;
        },
      },
    },
    readSnapshots: snapshots,
    scheduler,
    random: () => 0.5,
    id: randomUUID,
    now: Date.now,
    // SLOW_LINK_DEBUG=1 prints the client's connection reports, for a run that stalls.
    ...(process.env.SLOW_LINK_DEBUG
      ? { report: (event: unknown) => process.stderr.write(`client: ${JSON.stringify(event)}\n`) }
      : {}),
  };
  if (route.path === "direct") {
    const origin = `https://${route.shaper.address}/`;
    return new Client({
      ...base,
      transport: () => pinnedSocketTransport(`wss://${route.shaper.address}/`, route.fingerprint),
      credential: ticketCredential(
        async () => route.token,
        (token) =>
          accessRequest(origin, "/v1/tickets", {
            method: "POST",
            token,
            fingerprint: route.fingerprint,
          }).catch((error: unknown) => {
            if (process.env.SLOW_LINK_DEBUG) process.stderr.write(`ticket: ${String(error)}\n`);
            throw error;
          }),
      ),
    });
  }
  if (!route.relayUrl || !route.relayHostId) throw new Error("The daemon did not join the relay");
  const relay = new URL(route.relayUrl);
  relay.host = route.shaper.address;
  const relayed = relayRoute({
    relayUrl: relay.toString(),
    hostId: route.relayHostId,
    credential: async () => route.token,
    socket: browserDeviceSocket,
    schedule: (callback, delayMs) => scheduler.set(delayMs, callback),
  });
  return new Client({ ...base, transport: relayed.transport, credential: relayed.credential });
}

/** Time, round trips and bytes from a start mark to some later moment. */
export interface Span {
  ms: number;
  roundTrips: number;
  downBytes: number;
  upBytes: number;
  stalls: number;
}

export interface Mark {
  at: number;
  counts: LinkCounts;
}
export const mark = (shaper: LinkShaper): Mark => ({
  at: performance.now(),
  counts: shaper.counts(),
});
export function since(shaper: LinkShaper, from: Mark): Span {
  const delta = countsSince(from.counts, shaper.counts());
  return {
    ms: Math.round(performance.now() - from.at),
    roundTrips: delta.connections + delta.upFlights,
    downBytes: delta.downBytes,
    upBytes: delta.upBytes,
    stalls: delta.stalls,
  };
}

/**
 * Resolves with the span at the first moment `ready()` holds, checked on each change the
 * source reports, so the time is when the client could have painted it.
 */
export function when(
  shaper: LinkShaper,
  from: Mark,
  observe: (changed: () => void) => () => void,
  ready: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<Span> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop?.();
      reject(new Error(`${label}: not reached in ${timeoutMs} ms`));
    }, timeoutMs);
    const check = () => {
      if (!ready()) return;
      const span = since(shaper, from);
      clearTimeout(timer);
      stop?.();
      stop = undefined;
      resolve(span);
    };
    stop = observe(check);
    check();
  });
}

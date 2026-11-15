/**
 * Every step a phone waits for between dialling the relay and the daemon's welcome, timed from
 * the phone's side of a shaped link. A real daemon from this checkout (slow-link-daemon.ts,
 * temporary home, no provider CLI), the self-hosted relay on loopback, the real shared client
 * with the web app's options on a paired device's relay route, and the link shaper between the
 * phone and the relay. The client's relay socket is wrapped so each frame it sends and receives
 * is stamped: the WebSocket opening, the relay's pairing marker, the three Noise XX messages,
 * the hello and the first frame back. Three cases, each run several times:
 *
 * - cold: a client that has never seen the daemon;
 * - reconnect: the same client after its socket drops;
 * - relaunch: a new client on the first one's kept store, as an app started again.
 *
 *   bun apps/daemon/bench/relay-connect.ts [--profile=3g-slow] [--runs=5] [--output=FILE.json]
 *
 * Report only. The daemon-to-relay leg is loopback here, and the relay is plain `ws://`: a
 * production phone also pays a TLS round trip to the relay, the daemon's own dial to `/join`
 * on its link, and, for an account device, a grant fetch. ADR 0155 adds those.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { startRelay } from "@ace/relay";
import { Client, relayRoute, screenTail, type ConnectionState } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { accessRequest, redeemPairing } from "@ace/daemon/client-access";
import { DeviceId, PairingResponse } from "@ace/protocol";
import { linkProfile, startLinkShaper, type LinkShaper } from "@ace/perf-kit/link";
import { startBenchDaemon } from "@ace/perf-kit/daemon";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { FileSnapshots } from "./slow-link-client.ts";
import { writeMeasurement } from "./output.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const profile = linkProfile(argument("profile", "3g-slow"));
const runs = Number(argument("runs", "5"));
const output = argument("output", "");
const timeoutMs = 120_000;

const Thread = z.object({ id: z.string(), items: z.number(), turns: z.number() });
const Ready = z.object({
  endpoint: z.string(),
  token: z.string(),
  remoteUrl: z.string(),
  fingerprint: z.string(),
  relayHostId: z.string().optional(),
  threads: z.object({ small: Thread, typical: Thread, large: Thread, idle: Thread }),
});

/** One relay socket's frames, stamped in ms from when the client dialled it. */
interface Attempt {
  dialledAt: number;
  openMs?: number;
  received: number[];
  /** The size of each frame received, in bytes. */
  receivedBytes: number[];
  sent: number[];
  welcomeMs?: number;
  /** Shaper counts at the dial, to count this attempt's flights. */
  flightsAtDial: number;
  connectionsAtDial: number;
  flights?: number;
  connections?: number;
}

const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** A relay socket that stamps what it sends and receives, and can be dropped from outside. */
function stampedSockets(shaper: LinkShaper) {
  const attempts: Attempt[] = [];
  let current: { close(): void } | undefined;
  const socket: typeof browserDeviceSocket = (url, protocols) => {
    const counts = shaper.counts();
    const attempt: Attempt = {
      dialledAt: performance.now(),
      received: [],
      receivedBytes: [],
      sent: [],
      flightsAtDial: counts.upFlights,
      connectionsAtDial: counts.connections,
    };
    attempts.push(attempt);
    const real = browserDeviceSocket(url, protocols);
    const at = () => Math.round(performance.now() - attempt.dialledAt);
    real.addEventListener("open", () => (attempt.openMs = at()));
    real.addEventListener("message", ({ data }) => {
      attempt.received.push(at());
      const size =
        data instanceof ArrayBuffer
          ? data.byteLength
          : data instanceof Uint8Array
            ? data.length
            : 0;
      attempt.receivedBytes.push(size);
    });
    current = real;
    return {
      get binaryType() {
        return real.binaryType;
      },
      set binaryType(value: string) {
        real.binaryType = value;
      },
      get bufferedAmount() {
        return real.bufferedAmount;
      },
      addEventListener: real.addEventListener.bind(real),
      send(data: string | Uint8Array) {
        attempt.sent.push(at());
        real.send(data);
      },
      close: () => real.close(),
    };
  };
  return { socket, attempts, drop: () => current?.close() };
}

function client(
  route: { relayUrl: string; relayHostId: string; deviceId: string; token: string },
  sockets: ReturnType<typeof stampedSockets>,
  snapshots: FileSnapshots,
) {
  const relayed = relayRoute({
    relayUrl: route.relayUrl,
    hostId: route.relayHostId,
    credential: async () => route.token,
    socket: sockets.socket,
    schedule: (callback, delayMs) => scheduler.set(delayMs, callback),
  });
  return new Client({
    // What the web app passes (apps/web/src/boot/client.ts).
    openTail: screenTail,
    monotonic: () => performance.now(),
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
    transport: relayed.transport,
    credential: relayed.credential,
  });
}

/** Resolves when `client` is ready on a socket dialled after `after` attempts. */
function welcomed(
  connection: Client,
  sockets: ReturnType<typeof stampedSockets>,
  after: number,
): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const state = connection.connectionState();
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop?.();
      reject(new Error("No welcome in time"));
    }, timeoutMs);
    const check = () => {
      const attempt = sockets.attempts.at(-1);
      if ((state.getSnapshot() as ConnectionState) !== "ready" || !attempt) return;
      if (sockets.attempts.length <= after) return;
      attempt.welcomeMs = Math.round(performance.now() - attempt.dialledAt);
      clearTimeout(timer);
      stop?.();
      resolve(attempt);
    };
    stop = state.subscribe(check);
    check();
  });
}

/** The phone's steps in one attempt, by what each frame is on the relay's stream protocol. */
function steps(attempt: Attempt, shaper: LinkShaper) {
  const counts = shaper.counts();
  return {
    open: attempt.openMs,
    // The relay's one-byte readiness marker: the daemon joined.
    marker: attempt.received[0],
    noise1Sent: attempt.sent[0],
    noise2Received: attempt.received[1],
    noise3Sent: attempt.sent[1],
    helloSent: attempt.sent[2],
    firstReply: attempt.received[2],
    firstReplyBytes: attempt.receivedBytes[2],
    secondReply: attempt.received[3],
    secondReplyBytes: attempt.receivedBytes[3],
    welcome: attempt.welcomeMs,
    flights: counts.upFlights - attempt.flightsAtDial,
    connections: counts.connections - attempt.connectionsAtDial,
  };
}
type Steps = ReturnType<typeof steps>;

async function measure() {
  const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
  const daemon = await startBenchDaemon({
    entry: join(import.meta.dirname, "slow-link-daemon.ts"),
    execPath: bunBinary(),
    parse: (ready) => Ready.parse(ready),
    env: { ACE_RELAY_URL: relay.url },
  });
  let shaper: LinkShaper | undefined;
  const clients: Client[] = [];
  const results: { cold: Steps[]; reconnect: Steps[]; relaunch: Steps[] } = {
    cold: [],
    reconnect: [],
    relaunch: [],
  };
  try {
    const { ready } = daemon;
    if (!ready.relayHostId) throw new Error("The daemon did not report a relay host id");
    const local = ready.endpoint.replace("ws:", "http:");
    const pairing = PairingResponse.parse(
      await accessRequest(local, "/v1/pairings", {
        method: "POST",
        token: ready.token,
        body: { scopes: ["read", "operate"] },
      }),
    );
    const device = await redeemPairing(pairing.url, "Relay connect phone");
    const upstream = new URL(relay.url);
    shaper = await startLinkShaper({
      target: { host: upstream.hostname, port: Number(upstream.port) },
      profile,
    });
    const shaped = new URL(relay.url);
    shaped.host = shaper.address;
    const route = {
      relayUrl: shaped.toString(),
      relayHostId: ready.relayHostId,
      deviceId: device.device.id,
      token: device.token,
    };
    for (let run = 0; run < runs; run++) {
      process.stderr.write(`relay-connect: run ${run + 1} of ${runs}\n`);
      const snapshots = new FileSnapshots(join(daemon.home, `client-${run}.json`));
      // Cold: nothing seen before.
      const sockets = stampedSockets(shaper);
      const first = client(route, sockets, snapshots);
      clients.push(first);
      const started = welcomed(first, sockets, 0);
      await first.start();
      results.cold.push(steps(await started, shaper));
      // Let the welcome's follow-up traffic finish before the drop.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // Reconnect: the same client after its socket drops.
      const before = sockets.attempts.length;
      const again = welcomed(first, sockets, before);
      sockets.drop();
      results.reconnect.push(steps(await again, shaper));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await first.close();
      // Relaunch: a new client on the same kept store.
      const relaunched = stampedSockets(shaper);
      const second = client(route, relaunched, snapshots);
      clients.push(second);
      const back = welcomed(second, relaunched, 0);
      await second.start();
      results.relaunch.push(steps(await back, shaper));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await second.close();
    }
  } finally {
    for (const each of clients) await each.close().catch(() => undefined);
    await shaper?.close();
    await daemon.close();
    await relay.close();
  }
  return results;
}

const median = (values: (number | undefined)[]) => {
  const known = values
    .filter((value): value is number => value !== undefined)
    .toSorted((a, b) => a - b);
  return known.length ? (known[Math.floor((known.length - 1) / 2)] ?? 0) : undefined;
};
function table(results: Awaited<ReturnType<typeof measure>>) {
  const keys = [
    "open",
    "marker",
    "noise1Sent",
    "noise2Received",
    "noise3Sent",
    "helloSent",
    "firstReply",
    "firstReplyBytes",
    "secondReply",
    "secondReplyBytes",
    "welcome",
    "flights",
    "connections",
  ] as const;
  const lines = [
    `step (median ms from dial, ${profile.name})`.padEnd(30) + "cold  reconnect  relaunch",
  ];
  for (const key of keys)
    lines.push(
      key.padEnd(30) +
        [results.cold, results.reconnect, results.relaunch]
          .map((series) => String(median(series.map((each) => each[key])) ?? "-").padStart(9))
          .join(" "),
    );
  return lines.join("\n");
}

const results = await measure();
process.stderr.write(`${table(results)}\n`);
const result = {
  bench: "relay-connect",
  profile,
  runs,
  startedAt: new Date().toISOString(),
  results,
};
if (output) await writeMeasurement(output, JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result)}\n`);

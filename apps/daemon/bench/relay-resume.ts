/**
 * A returning client reconnecting through the relay with one open thread and the sidebar
 * (ADR 0155, step 2): for XX (as on main, with step 1's early frame) and for NK, how long from
 * the reconnect's dial until
 *   (a) the welcome,
 *   (b) the open thread's new events are on screen (applied, even if not yet confirmed),
 *   (c) the open thread and the sidebar are confirmed current (neither syncing).
 * A real daemon in a temporary home (slow-link-daemon.ts), the self-hosted relay on loopback,
 * the link shaper between the client and the relay; a turn that asks a question runs while the
 * client is away. Nothing reads ~/.ace, starts a provider CLI or leaves the machine.
 *
 *   bun apps/daemon/bench/relay-resume.ts [--profile=3g-slow] [--runs=7] [--join-rtt=MS]
 *     [--load=N] [--output=FILE.json]
 *
 * `--load=N` keeps N busy processes running beside it, for how often an NK admission misses the
 * relay's refusal time on a loaded machine (each reconnect reports the handshake it ended on).
 */
import { spawn, type ChildProcess } from "node:child_process";
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
const runs = Number(argument("runs", "7"));
const output = argument("output", "");
const joinRtt = Number(argument("join-rtt", "0"));
const load = Number(argument("load", "0"));
const timeoutMs = 60_000;

const Thread = z.object({ id: z.string(), items: z.number(), turns: z.number() });
const Ready = z.object({
  endpoint: z.string(),
  token: z.string(),
  relayHostId: z.string().optional(),
  threads: z.object({ small: Thread, typical: Thread, large: Thread, idle: Thread }),
});
const Emitted = z.object({ head: z.number() });

const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Relay sockets, each with when it was dialled and the size of its first frame. */
function sockets() {
  const dials: { at: number; first?: number; opened?: number }[] = [];
  let current: { close(): void } | undefined;
  const socket: typeof browserDeviceSocket = (url, protocols) => {
    const dial: { at: number; first?: number; opened?: number } = { at: performance.now() };
    dials.push(dial);
    const real = browserDeviceSocket(url, protocols);
    real.addEventListener("open", () => (dial.opened ??= performance.now()));
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
      get protocol() {
        return real.protocol ?? "";
      },
      addEventListener: real.addEventListener.bind(real),
      send(data: string | Uint8Array) {
        dial.first ??= typeof data === "string" ? data.length : data.length;
        real.send(data);
      },
      close: () => real.close(),
    };
  };
  return { socket, dials, drop: () => current?.close() };
}

function client(
  route: { relayUrl: string; relayHostId: string; deviceId: string; token: string },
  socket: ReturnType<typeof sockets>["socket"],
  snapshots: FileSnapshots,
  nk: boolean,
) {
  const relayed = relayRoute({
    relayUrl: route.relayUrl,
    hostId: route.relayHostId,
    credential: async () => route.token,
    socket,
    schedule: (callback, delayMs) => scheduler.set(delayMs, callback),
    nk,
  });
  return new Client({
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

/** Polls `check` every millisecond; the time it first held, or a timeout. */
async function when(check: () => boolean): Promise<number> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return performance.now();
}

type Resume = {
  /** The reconnect's socket opened (TCP and the upgrade). */
  open: number;
  welcome: number;
  events: number;
  current: number;
  handshake: "xx" | "nk";
  dials: number;
};

async function measure() {
  const busy: ChildProcess[] = [];
  for (let n = 0; n < load; n++)
    busy.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
  const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
  const relayAddress = new URL(relay.url);
  const daemonLeg =
    joinRtt > 0
      ? await startLinkShaper({
          target: { host: relayAddress.hostname, port: Number(relayAddress.port) },
          profile: {
            name: `daemon-leg-${joinRtt}`,
            downBitsPerSecond: null,
            upBitsPerSecond: null,
            rttMs: joinRtt,
            loss: 0,
            stallMs: 0,
            queueBytes: 64 * 1024,
          },
        })
      : undefined;
  const daemonRelay = new URL(relay.url);
  if (daemonLeg) daemonRelay.host = daemonLeg.address;
  const daemon = await startBenchDaemon({
    entry: join(import.meta.dirname, "slow-link-daemon.ts"),
    execPath: bunBinary(),
    parse: (ready) => Ready.parse(ready),
    env: { ACE_RELAY_URL: daemonRelay.toString() },
  });
  let shaper: LinkShaper | undefined;
  const results: Record<"xx" | "nk", Resume[]> = { xx: [], nk: [] };
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
    const device = await redeemPairing(pairing.url, "Relay resume phone");
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
    const threadId = ready.threads.typical.id;
    for (let run = 0; run < runs; run++)
      for (const mode of ["xx", "nk"] as const) {
        process.stderr.write(`relay-resume: run ${run + 1} of ${runs}, ${mode}\n`);
        const links = sockets();
        const snapshots = new FileSnapshots(join(daemon.home, `client-${mode}-${run}.json`));
        const connection = client(route, links.socket, snapshots, mode === "nk");
        await connection.start();
        const thread = connection.thread(threadId);
        const sidebar = connection.threads();
        const state = connection.connectionState();
        const current = () =>
          (state.getSnapshot() as ConnectionState) === "ready" &&
          !thread.store.syncing &&
          !sidebar.store.syncing &&
          thread.store.cursor !== undefined;
        await when(current);
        // Let the welcome's follow-ups (and NK's next ticket) land before the drop.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const before = links.dials.length;
        links.drop();
        // While it is away: a turn on the open thread that ends asking a question.
        const { head } = Emitted.parse(await daemon.request({ op: "question", thread: threadId }));
        await when(() => links.dials.length > before);
        const dialled = links.dials[before]?.at ?? performance.now();
        const welcomed = when(() => (state.getSnapshot() as ConnectionState) === "ready");
        const applied = when(() => (thread.store.cursor ?? 0) >= head);
        const confirmed = when(() => current() && (thread.store.cursor ?? 0) >= head);
        const [welcome, events, done] = await Promise.all([welcomed, applied, confirmed]);
        const last = links.dials.at(-1);
        const opened = links.dials[before]?.opened ?? dialled;
        results[mode].push({
          open: Math.round(opened - dialled),
          welcome: Math.round(welcome - dialled),
          events: Math.round(events - dialled),
          current: Math.round(done - dialled),
          handshake: last?.first === 32 ? "xx" : "nk",
          dials: links.dials.length - before,
        });
        thread.release();
        sidebar.release();
        await connection.close();
      }
  } finally {
    await shaper?.close();
    await daemon.close();
    await daemonLeg?.close();
    await relay.close();
    for (const child of busy) child.kill("SIGKILL");
  }
  return results;
}

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

const results = await measure();
const lines = [
  `relay resume (median ms from the reconnect's dial, ${profile.name}, join rtt ${joinRtt}, load ${load})`,
  "                  open  welcome  events  current  ended on NK  dials",
];
for (const mode of ["xx", "nk"] as const) {
  const each = results[mode];
  lines.push(
    `${mode.padEnd(14)} ${String(median(each.map((r) => r.open))).padStart(7)} ${String(median(each.map((r) => r.welcome))).padStart(8)} ${String(median(each.map((r) => r.events))).padStart(7)} ${String(median(each.map((r) => r.current))).padStart(8)} ${String(each.filter((r) => r.handshake === "nk").length).padStart(6)}/${each.length} ${String(Math.max(...each.map((r) => r.dials))).padStart(6)}`,
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
const measurement = {
  bench: "relay-resume",
  profile,
  joinRtt,
  load,
  runs,
  startedAt: new Date().toISOString(),
  results,
};
if (output) await writeMeasurement(output, `${JSON.stringify(measurement, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(measurement)}\n`);

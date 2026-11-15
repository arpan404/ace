/**
 * Every byte the daemon sends a returning client, from its hello until its open thread and its
 * sidebar are confirmed current, by message type, with what the big ones hold. Relay path over
 * 3g-slow, the real shared client with the web app's options, the head-of-line bench daemon
 * (its relay-channel probe sees every line the daemon sends). Three returns:
 *
 * - quiet: back after a short drop with nothing changed;
 * - away: back after time away while a few threads (and the open one) were active;
 * - relaunch: the app started again with its kept store;
 * - cold relaunch: the same, its kept store slow to read (400 ms a record), as a cold store is.
 *
 *   bun apps/daemon/bench/reconnect-bytes.ts [--runs=1] [--output=FILE.json]
 *
 * Report only. The daemon runs in a temporary home with no provider CLI.
 */
import { join } from "node:path";
import { z } from "zod";
import { startRelay } from "@ace/relay";
import { accessRequest, redeemPairing } from "@ace/daemon/client-access";
import { PairingResponse } from "@ace/protocol";
import { linkProfile, startLinkShaper } from "@ace/perf-kit/link";
import type { Client, ThreadSource } from "@ace/client";
import { startBenchDaemon } from "@ace/perf-kit/daemon";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { FileSnapshots, shapedClient, type Route } from "./slow-link-client.ts";
import { writeMeasurement } from "./output.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = Number(argument("runs", "1"));
const output = argument("output", "");
const timeout = Number(process.env.RECONNECT_TIMEOUT ?? 180_000);
const epoch = () => performance.timeOrigin + performance.now();

const Thread = z.object({ id: z.string(), items: z.number(), turns: z.number() });
const Ready = z.object({
  endpoint: z.string(),
  token: z.string(),
  remoteUrl: z.string(),
  fingerprint: z.string(),
  relayHostId: z.string().optional(),
  threads: z.object({
    small: Thread,
    typical: Thread,
    idle: Thread,
    big: Thread,
    live: Thread,
    away: Thread,
  }),
  spares: z.array(z.string()),
});
const Line = z.object({
  at: z.number(),
  type: z.string(),
  bytes: z.number(),
  subscriptionId: z.string().optional(),
  payloads: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
  threads: z.array(z.string()).optional(),
  patched: z.number().optional(),
  removed: z.number().optional(),
  view: z.object({ kind: z.string(), items: z.number(), threads: z.number() }).optional(),
});
const Probe = z.object({ sentLines: z.array(Line), hellos: z.array(z.number()) });

function until(
  observe: (changed: () => void) => () => void,
  ready: () => boolean,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop?.();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeout);
    const check = () => {
      if (!ready()) return;
      clearTimeout(timer);
      stop?.();
      resolve();
    };
    stop = observe(check);
    check();
  });
}
/** Confirmed current, as head-of-line.ts reads it: synced, confirmed, done filling in. */
const settled = (reader: ThreadSource) =>
  reader.thread !== undefined && !reader.syncing && !reader.unconfirmed && reader.filling !== true;

/**
 * One return's bytes: every line from the new connection's welcome (the relay host reads the
 * hello itself) to confirmed, by type and in detail.
 */
function account(lines: z.infer<typeof Line>[], to: number, threads: Record<string, string>) {
  const from = lines.findLast((line) => line.type === "welcome")?.at ?? 0;
  const kept = lines.filter((line) => line.at >= from && line.at <= to);
  const byType: Record<string, { count: number; bytes: number }> = {};
  const events: Record<string, { count: number; bytes: number; threads: Set<string> }> = {};
  const patches = { messages: 0, rows: 0, removed: 0, threads: new Map<string, number>() };
  const snapshots: { kind: string; items: number; threads: number; bytes: number }[] = [];
  for (const line of kept) {
    const entry = (byType[line.type] ??= { count: 0, bytes: 0 });
    entry.count++;
    entry.bytes += line.bytes;
    for (const [kind, [count, bytes]] of Object.entries(line.payloads ?? {})) {
      const event = (events[kind] ??= { count: 0, bytes: 0, threads: new Set() });
      event.count += count;
      event.bytes += bytes;
      for (const thread of line.threads ?? []) event.threads.add(threads[thread] ?? "other");
    }
    if (line.type === "threads.patch") {
      patches.messages++;
      patches.rows += line.patched ?? 0;
      patches.removed += line.removed ?? 0;
      for (const thread of line.threads ?? []) {
        const name = threads[thread] ?? "other";
        patches.threads.set(name, (patches.threads.get(name) ?? 0) + 1);
      }
    }
    if (line.type === "snapshot" && line.view) snapshots.push({ ...line.view, bytes: line.bytes });
  }
  // Sent before the new connection's welcome: to the old socket while the client was going away.
  const earlier: Record<string, { count: number; bytes: number }> = {};
  for (const line of lines.filter((sent) => sent.at < from)) {
    const entry = (earlier[line.type] ??= { count: 0, bytes: 0 });
    entry.count++;
    entry.bytes += line.bytes;
  }
  return {
    beforeWelcome: earlier,
    ms: Math.round(to - from),
    bytes: kept.reduce((total, line) => total + line.bytes, 0),
    byType,
    events: Object.fromEntries(
      Object.entries(events).map(([kind, entry]) => [
        kind,
        { ...entry, threads: [...entry.threads] },
      ]),
    ),
    patches: { ...patches, threads: Object.fromEntries(patches.threads) },
    snapshots,
  };
}

async function session() {
  const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
  const daemon = await startBenchDaemon({
    entry: join(import.meta.dirname, "head-of-line-daemon.ts"),
    execPath: bunBinary(),
    parse: (ready) => Ready.parse(ready),
    env: { SLOW_LINK_HOL: "1", ACE_RELAY_URL: relay.url },
  });
  const shaper = await startLinkShaper({
    target: { host: new URL(relay.url).hostname, port: Number(new URL(relay.url).port) },
    profile: linkProfile("3g-slow"),
  });
  const clients: Client[] = [];
  try {
    const { ready } = daemon;
    const pairing = PairingResponse.parse(
      await accessRequest(ready.endpoint.replace("ws:", "http:"), "/v1/pairings", {
        method: "POST",
        token: ready.token,
        body: { scopes: ["read", "operate"] },
      }),
    );
    const device = await redeemPairing(pairing.url, "Returning phone");
    if (!ready.relayHostId) throw new Error("The daemon did not join the relay");
    const route: Route = {
      path: "relay",
      shaper,
      deviceId: device.device.id,
      token: device.token,
      fingerprint: ready.fingerprint,
      relayUrl: relay.url,
      relayHostId: ready.relayHostId,
    };
    const snapshotsFile = join(daemon.home, "snapshots.json");
    const names: Record<string, string> = Object.fromEntries(
      Object.entries(ready.threads).map(([name, thread]) => [thread.id, name]),
    );
    const active = ready.spares.slice(0, 3);
    for (const [index, id] of active.entries()) names[id] = `active-${index + 1}`;
    const openThread = ready.threads.typical.id;

    /**
     * A client on the kept store, with the typical thread open; resolves once all is current.
     * The store is read back from its file first, as an app reads its own at launch.
     */
    const start = async (readMs = 0) => {
      const snapshots = new FileSnapshots(snapshotsFile, readMs);
      await snapshots.load();
      const phone = shapedClient(route, snapshots);
      clients.push(phone);
      await phone.start();
      const sidebar = phone.threads().store;
      const lease = phone.thread(openThread);
      return { phone, sidebar, lease, snapshots };
    };
    const current = async (client: Awaited<ReturnType<typeof start>>, head: number) => {
      const state = client.phone.connectionState();
      if (process.env.RECONNECT_DEBUG)
        state.subscribe(() => console.error("state", state.getSnapshot()));
      await until(
        (changed) => state.subscribe(changed),
        () => state.getSnapshot() === "ready",
        "welcome",
      );
      await until(
        (changed) => client.sidebar.observe(changed),
        () => client.sidebar.loaded && !client.sidebar.syncing,
        "sidebar",
      );
      await until(
        (changed) => client.lease.store.observe(changed),
        () => settled(client.lease.store) && (client.lease.store.cursor ?? 0) >= head,
        "open thread",
      );
      return epoch();
    };
    const probe = async () => Probe.parse(await daemon.request({ op: "probe-read" }));

    const first = await start();
    await current(first, 0);
    const results: Record<
      string,
      ReturnType<typeof account> & { linkBytes: number; returnMs: number }
    > = {};
    const down = () => shaper.counts().downBytes;

    // (i) quiet: a short drop, nothing changed.
    await daemon.request({ op: "probe-reset" });
    first.phone.networkOnline(false);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let linkFrom = down();
    let returnAt = epoch();
    first.phone.networkOnline(true);
    const quietDone = await current(first, 0);
    let read = await probe();
    results.quiet = {
      ...account(read.sentLines, quietDone, names),
      linkBytes: down() - linkFrom,
      returnMs: Math.round(quietDone - returnAt),
    };

    // (ii) away: a few threads active, the open one too, while the client is offline.
    await daemon.request({ op: "probe-reset" });
    first.phone.networkOnline(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    let newest = 0;
    for (const id of [...active, openThread]) {
      const streamed = z
        .object({ head: z.number() })
        .parse(await daemon.request({ op: "stream", thread: id, deltas: 60, bytes: 60 }));
      newest = Math.max(newest, streamed.head);
    }
    const asked = z
      .object({ head: z.number() })
      .parse(await daemon.request({ op: "question", thread: active[0] }));
    newest = Math.max(newest, asked.head);
    linkFrom = down();
    returnAt = epoch();
    first.phone.networkOnline(true);
    const awayDone = await current(first, newest);
    read = await probe();
    results.away = {
      ...account(read.sentLines, awayDone, names),
      linkBytes: down() - linkFrom,
      returnMs: Math.round(awayDone - returnAt),
    };

    // (iii) relaunch: the app starts again on its kept store, nothing changed meanwhile. The
    // views write their copies, the app closes, and its store goes to disk, as on a swipe away.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    first.lease.release();
    await first.phone.close();
    await first.snapshots.save();
    await daemon.request({ op: "probe-reset" });
    linkFrom = down();
    returnAt = epoch();
    const second = await start();
    const relaunchDone = await current(second, newest);
    read = await probe();
    results.relaunch = {
      ...account(read.sentLines, relaunchDone, names),
      linkBytes: down() - linkFrom,
      returnMs: Math.round(relaunchDone - returnAt),
    };

    // (iv) cold relaunch: again, the kept store now slow to read, as a cold one is at launch.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    second.lease.release();
    await second.phone.close();
    await second.snapshots.save();
    await daemon.request({ op: "probe-reset" });
    linkFrom = down();
    returnAt = epoch();
    const third = await start(400);
    const coldDone = await current(third, newest);
    read = await probe();
    results.coldRelaunch = {
      ...account(read.sentLines, coldDone, names),
      linkBytes: down() - linkFrom,
      returnMs: Math.round(coldDone - returnAt),
    };
    third.lease.release();
    return results;
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    await shaper.close();
    await daemon.close();
    await relay.close();
  }
}

const all = [];
for (let run = 1; run <= runs; run++) {
  const result = await session();
  console.log(`reconnect-bytes run ${run}`);
  for (const [name, r] of Object.entries(result))
    console.log(
      `  ${name}: ${r.bytes} bytes of JSON (${r.linkBytes} on the link), ${r.returnMs} ms to current, ${JSON.stringify(r.byType)}`,
    );
  all.push(result);
}
if (output)
  await writeMeasurement(
    output,
    JSON.stringify({ bench: "reconnect-bytes", results: all }, null, 2),
  );
process.exit(0);

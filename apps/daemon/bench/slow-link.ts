/**
 * The daemon's data path over a slow link: a real daemon from this checkout (slow-link-daemon.ts,
 * temporary home, recorded threads, no provider CLI) and the real client, with a link shaper
 * (@ace/perf-kit/link) between them. For each path (the pinned TLS listener a paired device
 * uses, the relay) and each link profile it reports time, round trips and daemon bytes from
 * connect to welcome and to the first sidebar rows; to first content of threads the client has
 * never seen; to confirmation of a thread it kept on disk; an approval's delay on an idle link
 * and while a large snapshot is in flight; and catching up after a long streamed turn.
 *
 *   bun apps/daemon/bench/slow-link.ts [--profiles=3g-slow,3g-fast,lan] [--paths=direct,relay]
 *     [--output=FILE.json]
 *
 * Report only, never a gate. See slow-link-REPORT.md for the baseline and the model's limits.
 */
import { loadavg, cpus } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startRelay } from "@ace/relay";
import { accessRequest, redeemPairing } from "@ace/daemon/client-access";
import { PairingResponse } from "@ace/protocol";
import { linkProfile, startLinkShaper, type LinkShaper } from "@ace/perf-kit/link";
import type { Client, ThreadSource } from "@ace/client";
import { startBenchDaemon } from "@ace/perf-kit/daemon";
import { bunBinary } from "../../../scripts/runtimes.ts";
import {
  FileSnapshots,
  mark,
  shapedClient,
  since,
  when,
  type LinkPath,
  type Route,
  type Span,
} from "./slow-link-client.ts";
import { writeMeasurement } from "./output.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const profiles = argument("profiles", "3g-slow,3g-fast,lan").split(",").map(linkProfile);
const paths = z
  .array(z.enum(["direct", "relay"]))
  .parse(argument("paths", "direct,relay").split(","));
const output = argument("output", "");
/** The long streamed turn the resume catches up on: deltas and bytes per delta. */
const stream = { deltas: 2_000, bytes: 60 };

const Thread = z.object({ id: z.string(), items: z.number(), turns: z.number() });
const Ready = z.object({
  endpoint: z.string(),
  token: z.string(),
  remoteUrl: z.string(),
  fingerprint: z.string(),
  relayHostId: z.string().optional(),
  threads: z.object({ small: Thread, typical: Thread, large: Thread, idle: Thread }),
});
const Emitted = z.object({ emittedAt: z.number(), head: z.number() });
const epoch = () => performance.timeOrigin + performance.now();

const selection = (client: Client) => {
  const state = client.connectionState();
  return { observe: (changed: () => void) => state.subscribe(changed), state };
};
const settled = (reader: ThreadSource) =>
  reader.thread !== undefined && !reader.syncing && !reader.unconfirmed;
const hasContent = (reader: ThreadSource) => reader.thread !== undefined && reader.order.length > 0;

async function measure(path: LinkPath, profileName: string) {
  const profile = linkProfile(profileName);
  const relay = path === "relay" ? await startRelay({ port: 0, bind: "127.0.0.1" }) : undefined;
  const daemon = await startBenchDaemon({
    entry: join(import.meta.dirname, "slow-link-daemon.ts"),
    execPath: bunBinary(),
    parse: (ready) => Ready.parse(ready),
    env: relay ? { ACE_RELAY_URL: relay.url } : {},
  });
  let shaper: LinkShaper | undefined;
  const clients: Client[] = [];
  try {
    const { ready } = daemon;
    const local = ready.endpoint.replace("ws:", "http:");
    const pairing = PairingResponse.parse(
      await accessRequest(local, "/v1/pairings", {
        method: "POST",
        token: ready.token,
        body: { scopes: ["read", "operate"] },
      }),
    );
    const device = await redeemPairing(pairing.url, "Slow link phone");
    const upstream = new URL(relay ? relay.url : ready.remoteUrl);
    shaper = await startLinkShaper({
      target: { host: upstream.hostname, port: Number(upstream.port) },
      profile,
    });
    const relayHostId = ready.relayHostId;
    if (relay && !relayHostId) throw new Error("The daemon did not report a relay host id");
    const route: Route = {
      path,
      shaper,
      deviceId: device.device.id,
      token: device.token,
      fingerprint: ready.fingerprint,
      ...(relay && relayHostId ? { relayUrl: relay.url, relayHostId } : {}),
    };
    const link = shaper;
    const timeout = 180_000;
    const snapshots = new FileSnapshots(join(daemon.home, "client-snapshots.json"));

    // A client that has never seen this daemon: connect, sidebar, then threads it never opened.
    const cold = shapedClient(route, snapshots);
    clients.push(cold);
    const connect = mark(link);
    const sidebar = cold.threads().store;
    await cold.start();
    const { observe: watchState, state } = selection(cold);
    if (process.env.SLOW_LINK_DEBUG)
      watchState(() =>
        process.stderr.write(`state: ${state.getSnapshot()} ${String(cold.error ?? "")}\n`),
      );
    const welcome = await when(
      link,
      connect,
      watchState,
      () => state.getSnapshot() === "ready",
      timeout,
      "welcome",
    );
    const sidebarRows = await when(
      link,
      connect,
      (changed) => sidebar.observe(changed),
      () => sidebar.loaded && sidebar.ids.length > 0 && !sidebar.syncing,
      timeout,
      "sidebar",
    );
    const open = async (id: string, label: string) => {
      const from = mark(link);
      const reader = cold.thread(id).store;
      const watch = (changed: () => void) => reader.observe(changed);
      const first = await when(
        link,
        from,
        watch,
        () => hasContent(reader),
        timeout,
        `${label} first content`,
      );
      const complete = await when(
        link,
        from,
        watch,
        () => settled(reader),
        timeout,
        `${label} complete`,
      );
      return { reader, first, complete };
    };
    const small = await open(ready.threads.small.id, "small");
    const idle = await open(ready.threads.idle.id, "idle");
    const typical = await open(ready.threads.typical.id, "typical");

    // An approval over the idle link, then one sent while the large snapshot is on its way.
    const approval = async (reader: ThreadSource, thread: string) => {
      const arrived = new Promise<number>((resolve) => {
        const stop = reader.observe(() => {
          if (reader.interactionIds().length === 0) return;
          stop();
          resolve(epoch());
        });
      });
      const { emittedAt } = Emitted.parse(await daemon.request({ op: "question", thread }));
      return Math.round((await arrived) - emittedAt);
    };
    const idleApprovalMs = await approval(idle.reader, ready.threads.idle.id);
    const largeFrom = mark(link);
    const largeReader = cold.thread(ready.threads.large.id).store;
    const watchLarge = (changed: () => void) => largeReader.observe(changed);
    const largeFirst = when(
      link,
      largeFrom,
      watchLarge,
      () => hasContent(largeReader),
      timeout,
      "large first content",
    );
    const largeComplete = when(
      link,
      largeFrom,
      watchLarge,
      () => settled(largeReader),
      timeout,
      "large complete",
    );
    // The snapshot is in flight once its first bytes are crossing.
    while (link.counts().downBytes - largeFrom.counts.downBytes < 4096)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const duringSnapshotMs = await approval(small.reader, ready.threads.small.id);
    const large = { first: await largeFirst, complete: await largeComplete };

    // Let the views write their snapshots, then close as an app being swiped away does.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await cold.close();
    const keptBytes = await snapshots.save();

    // The same phone again: its typical thread is on disk; how soon does the daemon confirm it?
    const kept = new FileSnapshots(snapshots.file);
    await kept.load();
    const warm = shapedClient(route, kept);
    clients.push(warm);
    const keptReader = warm.thread(ready.threads.typical.id).store;
    const connectAgain = mark(link);
    await warm.start();
    const warmState = selection(warm);
    // What the phone paints before the network answers: the kept copy, read back from disk.
    let unconfirmedFromDisk = false;
    const painted = when(
      link,
      connectAgain,
      (changed) => keptReader.observe(changed),
      () => {
        if (keptReader.order.length === 0) return false;
        unconfirmedFromDisk = keptReader.unconfirmed === true;
        return true;
      },
      timeout,
      "paint from disk",
    );
    const rewelcome = when(
      link,
      connectAgain,
      warmState.observe,
      () => warmState.state.getSnapshot() === "ready",
      timeout,
      "cached welcome",
    );
    const confirmed = await when(
      link,
      connectAgain,
      (changed) => keptReader.observe(changed),
      () => settled(keptReader),
      timeout,
      "cached confirm",
    );
    const paint = await painted;

    // Offline through a long streamed turn, then back: what does catching up cost?
    warm.networkOnline(false);
    const { head } = z
      .object({ head: z.number() })
      .parse(await daemon.request({ op: "stream", thread: ready.threads.typical.id, ...stream }));
    const resumeFrom = mark(link);
    warm.networkOnline(true);
    const resume = await when(
      link,
      resumeFrom,
      (changed) => keptReader.observe(changed),
      // Caught up once the view holds the daemon's last event and shows the turn finished. (The
      // client keeps at most 64 KiB of one message's text, so its length is no signal.)
      () =>
        settled(keptReader) &&
        (keptReader.cursor ?? 0) >= head &&
        keptReader.thread?.status.state === "done",
      timeout,
      "resume",
    );
    await warm.close();
    return {
      path,
      profile: profile.name,
      threads: {
        small: ready.threads.small.items,
        typical: ready.threads.typical.items,
        large: ready.threads.large.items,
      },
      welcome,
      sidebar: sidebarRows,
      firstContent: { small: small.first, typical: typical.first, large: large.first },
      complete: { small: small.complete, typical: typical.complete, large: large.complete },
      cached: {
        /** Painted from disk before the daemon confirmed it: a copy marked unconfirmed. */
        unconfirmedFromDisk,
        paint,
        keptBytes,
        welcome: await rewelcome,
        confirmed,
      },
      approval: { idleMs: idleApprovalMs, duringLargeSnapshotMs: duringSnapshotMs },
      resume: { ...resume, streamedTextBytes: stream.deltas * stream.bytes, deltas: stream.deltas },
      totals: since(link, connect),
    };
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    await shaper?.close();
    await daemon.close();
    await relay?.close();
  }
}

const startedAt = new Date().toISOString();
const loadBefore = loadavg();
const runs: Awaited<ReturnType<typeof measure>>[] = [];
for (const path of paths)
  for (const profile of profiles) {
    process.stderr.write(`slow-link: ${path} over ${profile.name}\n`);
    const run = await measure(path, profile.name);
    runs.push(run);
    process.stderr.write(`${summary(run)}\n`);
  }

function span(label: string, value: Span): string {
  return `  ${label.padEnd(34)} ${String(value.ms).padStart(7)} ms ${String(value.roundTrips).padStart(3)} RT ${(value.downBytes / 1024).toFixed(1).padStart(8)} KiB down`;
}

function summary(run: (typeof runs)[number]): string {
  return [
    `${run.path} / ${run.profile}`,
    span("welcome", run.welcome),
    span("first sidebar rows", run.sidebar),
    span("small thread, first content", run.firstContent.small),
    span("typical thread, first content", run.firstContent.typical),
    span("large thread, first content", run.firstContent.large),
    span("large thread, complete", run.complete.large),
    span("cached thread, painted from disk", run.cached.paint),
    span("cached thread, confirmed", run.cached.confirmed),
    span("resume after long turn", run.resume),
    `  approval delay: idle ${run.approval.idleMs} ms, during large snapshot ${run.approval.duringLargeSnapshotMs} ms`,
  ].join("\n");
}

const result = {
  bench: "slow-link",
  startedAt,
  machine: { cpus: cpus().length, loadBefore, loadAfter: loadavg() },
  profiles: profiles.map((profile) => profile),
  runs,
};
if (output) await writeMeasurement(output, JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result)}\n`);

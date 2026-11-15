/**
 * Head-of-line delay over a slow link, and what the relay channel's deflate costs the daemon's
 * event loop. A sibling of slow-link.ts with the same daemon (head-of-line-daemon.ts: the
 * slow-link daemon with the relay channel's deflates timed), shaper and client.
 *
 * For each path and profile, `--runs` daemons in turn. In each, every urgent kind is measured on
 * an idle link, then again while each kind of bulk traffic is in flight:
 *
 * - snapshot: the full snapshot that completes a first open of a 600-item thread;
 * - resume: the catch-up after bulky turns (24 KiB tool outputs) ran while the client was away;
 * - catch-up: the catch-up after a 2,000-delta streamed turn;
 * - live: a stream of deltas at full rate;
 * - raw: an `item.raw` page of the streamed item (its provider frames).
 *
 * Urgent kinds: a question raised on another thread (as the thread shows it, and as the sidebar
 * shows the thread going to needs_you), one on the same thread as the bulk, a Stop's
 * acknowledgement and a send's receipt. A question's wait runs from when the daemon raised it to
 * when the client could paint it; a command's from the client's call to its receipt. Beside each
 * is what the link delivered to the client meanwhile: the bytes that were ahead of it.
 *
 *   bun apps/daemon/bench/head-of-line.ts [--profiles=3g-slow,3g-fast] [--paths=direct,relay]
 *     [--runs=3] [--output=FILE.json]
 *
 * Report only. The daemon runs in a temporary home with no provider CLI (slow-link-daemon.ts).
 */
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startRelay } from "@ace/relay";
import { accessRequest, redeemPairing } from "@ace/daemon/client-access";
import { PairingResponse, ThreadId } from "@ace/protocol";
import { linkProfile, startLinkShaper, type LinkShaper } from "@ace/perf-kit/link";
import type { Client, ThreadSource } from "@ace/client";
import { startBenchDaemon } from "@ace/perf-kit/daemon";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { FileSnapshots, shapedClient, type LinkPath, type Route } from "./slow-link-client.ts";
import { writeMeasurement } from "./output.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const profiles = argument("profiles", "3g-slow,3g-fast").split(",");
const paths = z
  .array(z.enum(["direct", "relay"]))
  .parse(argument("paths", "direct,relay").split(","));
const runs = Number(argument("runs", "3"));
const output = argument("output", "");
const timeout = 180_000;

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
const Emitted = z.object({ emittedAt: z.number(), head: z.number() });
const Head = z.object({ head: z.number() });
const Probe = z.object({
  longestGaps: z.array(z.object({ ms: z.number(), deflateMs: z.number() })),
  deflates: z.array(z.object({ bytes: z.number(), ms: z.number() })),
});
const epoch = () => performance.timeOrigin + performance.now();

/** One urgent message's wait, and the bytes the link delivered to the client meanwhile. */
interface Wait {
  ms: number;
  aheadBytes: number;
}
type Urgent = "otherApproval" | "sidebarNeedsYou" | "sameApproval" | "stopAck" | "sendReceipt";
type UrgentSet = Partial<Record<Urgent, Wait>> & { failed?: string[] };
type Bulk = "snapshot" | "resume" | "catchUp" | "live" | "raw";

/** Resolves when `ready()` first holds, checked on each change `observe` reports. */
function until(
  observe: (changed: () => void) => () => void,
  ready: () => boolean,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop?.();
      reject(new Error(`${label}: not reached in ${timeout} ms`));
    }, timeout);
    const check = () => {
      if (!ready()) return;
      clearTimeout(timer);
      stop?.();
      stop = undefined;
      resolve();
    };
    stop = observe(check);
    check();
  });
}

const settled = (reader: ThreadSource) =>
  reader.thread !== undefined && !reader.syncing && !reader.unconfirmed;

async function session(path: LinkPath, profileName: string) {
  const profile = linkProfile(profileName);
  const relay = path === "relay" ? await startRelay({ port: 0, bind: "127.0.0.1" }) : undefined;
  const daemon = await startBenchDaemon({
    entry: join(import.meta.dirname, "head-of-line-daemon.ts"),
    execPath: bunBinary(),
    parse: (ready) => Ready.parse(ready),
    env: { SLOW_LINK_HOL: "1", ...(relay ? { ACE_RELAY_URL: relay.url } : {}) },
  });
  let shaper: LinkShaper | undefined;
  let client: Client | undefined;
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
    const device = await redeemPairing(pairing.url, "Head-of-line phone");
    const upstream = new URL(relay ? relay.url : ready.remoteUrl);
    shaper = await startLinkShaper({
      target: { host: upstream.hostname, port: Number(upstream.port) },
      profile,
    });
    const link = shaper;
    const route: Route = {
      path,
      shaper,
      deviceId: device.device.id,
      token: device.token,
      fingerprint: ready.fingerprint,
      ...(relay && ready.relayHostId
        ? { relayUrl: relay.url, relayHostId: ready.relayHostId }
        : {}),
    };
    const phone = shapedClient(route, new FileSnapshots(join(daemon.home, "snapshots.json")));
    client = phone;
    const sidebar = phone.threads().store;
    await phone.start();
    const state = phone.connectionState();
    await until(
      (changed) => state.subscribe(changed),
      () => state.getSnapshot() === "ready",
      "welcome",
    );
    await until(
      (changed) => sidebar.observe(changed),
      () => sidebar.loaded && sidebar.ids.length > 0 && !sidebar.syncing,
      "sidebar",
    );
    const down = () => link.counts().downBytes;
    const spares = [...ready.spares];
    const spare = () => {
      const id = spares.shift();
      if (!id) throw new Error("Out of spare threads");
      return id;
    };
    const open = async (id: string) => {
      const lease = phone.thread(id);
      await until(
        (changed) => lease.store.observe(changed),
        () => settled(lease.store),
        `open ${id}`,
      );
      return lease;
    };
    const command = (payload: Parameters<Client["command"]>[0]) =>
      phone.command(payload, { timeoutMs: timeout });
    const input = [{ type: "text" as const, text: "Next step, please" }];

    /** Threads the urgent messages use, ready before the bulk starts. */
    const prepare = async () => {
      const askedId = spare();
      const sentId = spare();
      const stopped = spare();
      const asked = await open(askedId);
      const sent = await open(sentId);
      // A turn in progress for the Stop to stop (the bench provider never ends it).
      await command({ type: "thread.send", threadId: ThreadId.parse(stopped), input });
      return { asked, askedId, sent, sentId, stopped };
    };
    type Prepared = Awaited<ReturnType<typeof prepare>>;

    const waitFor = async (
      label: string,
      start: { at: number; down: number },
      arrived: Promise<number>,
      failed: string[],
    ): Promise<Wait | undefined> => {
      try {
        const at = await arrived;
        return { ms: Math.round(at - start.at), aheadBytes: down() - start.down };
      } catch (error) {
        failed.push(`${label}: ${String(error)}`);
        return undefined;
      }
    };
    const interactionArrives = (reader: ThreadSource, label: string) => {
      const before = reader.interactionIds().length;
      return until(
        (changed) => reader.observe(changed),
        () => reader.interactionIds().length > before,
        label,
      ).then(epoch);
    };

    /** Every urgent kind at once; `same` is the bulk's own thread and how to ask on it. */
    const urgent = async (
      prepared: Prepared,
      same: { reader: ThreadSource; thread: string; running: boolean },
    ): Promise<UrgentSet> => {
      const failed: string[] = [];
      const asked = prepared.asked.store;
      const otherArrives = interactionArrives(asked, "other approval");
      const { askedId } = prepared;
      const sidebarArrives = until(
        (changed) => sidebar.observe(changed),
        () => sidebar.thread(askedId)?.status.state === "needs_you",
        "sidebar needs_you",
      ).then(epoch);
      const sameArrives = interactionArrives(same.reader, "same-thread approval");
      // The client's own: a Stop and a send, timed from the call to the receipt.
      const clientStart = { at: epoch(), down: down() };
      const stop = waitFor(
        "stop",
        clientStart,
        command({
          type: "thread.interrupt",
          threadId: ThreadId.parse(prepared.stopped),
          cascade: true,
        }).then(epoch),
        failed,
      );
      const send = waitFor(
        "send",
        clientStart,
        command({ type: "thread.send", threadId: ThreadId.parse(prepared.sentId), input }).then(
          epoch,
        ),
        failed,
      );
      // The daemon's own: questions, timed from when it raised them.
      const otherDown = down();
      const other = Emitted.parse(await daemon.request({ op: "question", thread: askedId }));
      const sameDown = down();
      const sameQuestion = Emitted.parse(
        await daemon.request({ op: same.running ? "ask" : "question", thread: same.thread }),
      );
      const otherApproval = await waitFor(
        "other approval",
        { at: other.emittedAt, down: otherDown },
        otherArrives,
        failed,
      );
      const sidebarNeedsYou = await waitFor(
        "sidebar",
        { at: other.emittedAt, down: otherDown },
        sidebarArrives,
        failed,
      );
      const sameApproval = await waitFor(
        "same approval",
        { at: sameQuestion.emittedAt, down: sameDown },
        sameArrives,
        failed,
      );
      const result: UrgentSet = {
        ...(otherApproval ? { otherApproval } : {}),
        ...(sidebarNeedsYou ? { sidebarNeedsYou } : {}),
        ...(sameApproval ? { sameApproval } : {}),
      };
      const stopAck = await stop;
      const sendReceipt = await send;
      if (stopAck) result.stopAck = stopAck;
      if (sendReceipt) result.sendReceipt = sendReceipt;
      if (failed.length) result.failed = failed;
      prepared.asked.release();
      prepared.sent.release();
      return result;
    };

    /** Waits until `bytes` more have crossed the link since `from`, or `done()` holds first. */
    const inFlight = async (from: number, bytes: number, done: () => boolean) => {
      while (down() - from < bytes && !done())
        await new Promise((resolve) => setTimeout(resolve, 5));
      return !done();
    };
    const probe = async <T>(run: () => Promise<T>) => {
      await daemon.request({ op: "probe-reset" });
      const value = await run();
      return { ...value, probe: Probe.parse(await daemon.request({ op: "probe-read" })) };
    };

    // Idle: nothing else on the link.
    const small = await open(ready.threads.small.id);
    const idle = await probe(async () => ({
      urgent: await urgent(await prepare(), {
        reader: small.store,
        thread: ready.threads.small.id,
        running: false,
      }),
    }));

    const episodes: Partial<Record<Bulk, unknown>> = {};

    // The full snapshot completing a first open of the 600-item thread.
    episodes.snapshot = await probe(async () => {
      const prepared = await prepare();
      const from = down();
      const startedAt = performance.now();
      const big = phone.thread(ready.threads.big.id);
      await until(
        (changed) => big.store.observe(changed),
        () => big.store.order.length > 0,
        "big first content",
      );
      const firstContentBytes = down() - from;
      const busy = await inFlight(down(), 4096, () => settled(big.store));
      const result = await urgent(prepared, {
        reader: big.store,
        thread: ready.threads.big.id,
        running: false,
      });
      await until(
        (changed) => big.store.observe(changed),
        () => settled(big.store),
        "big settled",
      );
      const bulk = {
        bytes: down() - from,
        ms: Math.round(performance.now() - startedAt),
        firstContentBytes,
        busyWhenProduced: busy,
      };
      big.release();
      return { urgent: result, bulk };
    });

    // A catch-up after the client was away: `play` runs while it is offline.
    const catchUp = async (thread: string, play: () => Promise<number>) => {
      const lease = await open(thread);
      const prepared = await prepare();
      phone.networkOnline(false);
      const head = await play();
      const from = down();
      const startedAt = performance.now();
      phone.networkOnline(true);
      const caughtUp = () => settled(lease.store) && (lease.store.cursor ?? 0) >= head;
      const busy = await inFlight(from, 4096, caughtUp);
      const result = await urgent(prepared, { reader: lease.store, thread, running: false });
      await until((changed) => lease.store.observe(changed), caughtUp, "caught up");
      const bulk = {
        bytes: down() - from,
        ms: Math.round(performance.now() - startedAt),
        busyWhenProduced: busy,
      };
      lease.release();
      return { urgent: result, bulk };
    };
    episodes.resume = await probe(() =>
      catchUp(
        ready.threads.away.id,
        async () =>
          Head.parse(await daemon.request({ op: "bulky", thread: ready.threads.away.id, count: 8 }))
            .head,
      ),
    );
    episodes.catchUp = await probe(() =>
      catchUp(
        ready.threads.typical.id,
        async () =>
          Head.parse(
            await daemon.request({
              op: "stream",
              thread: ready.threads.typical.id,
              deltas: 2_000,
              bytes: 60,
            }),
          ).head,
      ),
    );

    // A stream at full rate on a thread the client has open.
    const liveLease = await open(ready.threads.live.id);
    episodes.live = await probe(async () => {
      const prepared = await prepare();
      const from = down();
      const startedAt = performance.now();
      await daemon.request({ op: "live", thread: ready.threads.live.id, bytes: 60 });
      const busy = await inFlight(from, 32 * 1024, () => false);
      const result = await urgent(prepared, {
        reader: liveLease.store,
        thread: ready.threads.live.id,
        running: true,
      });
      const stopped = z
        .object({ deltas: z.number(), head: z.number() })
        .parse(await daemon.request({ op: "live-stop" }));
      await until(
        (changed) => liveLease.store.observe(changed),
        () => (liveLease.store.cursor ?? 0) >= stopped.head && settled(liveLease.store),
        "live caught up",
      );
      return {
        urgent: result,
        bulk: {
          bytes: down() - from,
          ms: Math.round(performance.now() - startedAt),
          deltas: stopped.deltas,
          busyWhenProduced: busy,
        },
      };
    });

    // A raw page: an item whose provider frame carried a large output, read as the raw-frames
    // view reads it.
    const rawHead = Head.parse(
      await daemon.request({ op: "raw-turn", thread: ready.threads.live.id, bytes: 900 * 1024 }),
    ).head;
    await until(
      (changed) => liveLease.store.observe(changed),
      () => (liveLease.store.cursor ?? 0) >= rawHead && settled(liveLease.store),
      "raw turn",
    );
    episodes.raw = await probe(async () => {
      // The first message after the raw turn's prompt that came without its raw: the padded one.
      const order = liveLease.store.order;
      const prompt = order.findLastIndex((id) => {
        const item = liveLease.store.item(id);
        return (
          item?.type === "message" &&
          item.role === "user" &&
          item.parts.some((part) => part.type === "text" && part.text === "Run the long command")
        );
      });
      const itemId = order.slice(prompt + 1).find((id) => {
        const item = liveLease.store.item(id);
        return item?.type === "message" && "rawOmitted" in item && item.rawOmitted === true;
      });
      if (!itemId) throw new Error("No item with its raw left out");
      const prepared = await prepare();
      const from = down();
      const startedAt = performance.now();
      let done = false;
      const reply = phone
        .request(
          { type: "item.raw", threadId: ready.threads.live.id, itemId, from: 0 },
          { timeoutMs: timeout },
        )
        .then((page) => {
          done = true;
          return page;
        });
      const busy = await inFlight(from, 4096, () => done);
      const result = await urgent(prepared, {
        reader: liveLease.store,
        thread: ready.threads.live.id,
        running: false,
      });
      const page = await reply;
      return {
        urgent: result,
        bulk: {
          bytes: down() - from,
          ms: Math.round(performance.now() - startedAt),
          rawBytes: "raw" in page ? JSON.stringify(page.raw).length : 0,
          busyWhenProduced: busy,
        },
      };
    });
    liveLease.release();
    small.release();
    return { idle, episodes };
  } finally {
    await client?.close().catch(() => undefined);
    await shaper?.close();
    await daemon.close();
    await relay?.close();
  }
}

const startedAt = new Date().toISOString();
const results: { path: LinkPath; profile: string; run: number; load: number[]; result: unknown }[] =
  [];
for (const path of paths)
  for (const profile of profiles)
    for (let run = 1; run <= runs; run++) {
      process.stderr.write(`head-of-line: ${path} over ${profile}, run ${run}\n`);
      const load = loadavg();
      const result = await session(path, profile);
      results.push({ path, profile, run, load: [...load, ...loadavg()], result });
      process.stderr.write(`${JSON.stringify(result)}\n`);
    }
const report = {
  bench: "head-of-line",
  startedAt,
  machine: { cpus: cpus().length },
  results,
};
if (output) await writeMeasurement(output, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report)}\n`);

/**
 * Bytes the daemon sends a client, before and after the hello's `raw-on-demand` trim and
 * `short-deltas` framing, and how many deltas share a frame on a slow remote link. Replays the
 * recorded sessions under fixtures/ (no provider CLI, no quota, never ~/.ace) through each
 * provider's translator, the core reducer and the projection, then encodes what a client would
 * receive with the daemon's own trimmer, encoder and outbox. Sizes are deflated alone, as the
 * remote listener and the relay do (level 6, no context carried over).
 *
 *   bun apps/daemon/bench/wire-trims.ts
 */
import { readdirSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { apply, createThreadState, type Fact } from "@ace/core";
import { readFixture } from "@ace/adapter-testkit";
import { applyEvent, createThreadView } from "@ace/projection";
import { supportedWireTrims, wireTrims, WireTrimmer } from "@ace/projection/wire-trim";
import { DeliveryEvent, Event, Thread, type ServerMessage, type ThreadView } from "@ace/protocol";
import { replayProviders } from "./adapter-replay-fixtures.ts";
import { compressionThresholdBytes } from "../src/compression-policy.ts";
import type { MainSocket } from "../src/main-socket.ts";
import { Outbox, defaultPressure } from "../src/outbox.ts";
import { WireEncoder, wholeEvents, type EventShape } from "../src/wire-encoder.ts";

const deflated = (text: string) => deflateRawSync(text, { level: 6 }).length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
/** Subscription ids the shared client makes are UUIDs. */
const subscriptionId = "5f0c1b2e-8d4a-4c55-9a8e-0b7c6d5e4f3a";
const before = supportedWireTrims.filter((trim) => trim !== wireTrims.rawOnDemand);
const clients = {
  untrimmed: { trims: undefined, shape: wholeEvents },
  "today's client": { trims: before, shape: wholeEvents },
  "raw-on-demand + short-deltas": {
    trims: [...supportedWireTrims],
    shape: { rawOnDemand: true, shortDeltas: true } satisfies EventShape,
  },
} as const;

interface Session {
  name: string;
  view: ThreadView;
  /** Every delivered event with the time its frame arrived, ms. */
  events: { t: number; event: DeliveryEvent }[];
}

async function sessions(): Promise<Session[]> {
  const all: Session[] = [];
  for (const [provider, replay] of Object.entries(replayProviders)) {
    for (const file of readdirSync(replay.directory).filter((name) => name.endsWith(".jsonl"))) {
      const fixture = await readFixture(`${replay.directory}${file}`);
      const thread = Thread.parse({
        id: "thread-1",
        workspaceId: "w",
        provider: replay.provider,
        title: file,
        status: { state: "new" },
        createdAt: 0,
        updatedAt: 0,
      });
      const state = createThreadState({
        threadId: thread.id,
        config: { provider: replay.provider, silenceMs: replay.silenceMs },
      });
      const translator = replay.createTranslator({ threadId: thread.id, rootKey: "root" });
      const view = createThreadView(thread);
      const events: Session["events"] = [];
      let id = 0;
      let seq = 0;
      const ids = { next: (kind: string) => `${kind}-${++id}` };
      const fold = (facts: Fact[], t: number) => {
        for (const fact of facts)
          for (const payload of apply(state, fact, { now: t, ids })) {
            const event = Event.parse({
              id: `01JXEVENT${String(++seq).padStart(17, "0")}`,
              seq,
              at: 1_731_600_000_000 + t,
              threadId: thread.id,
              payload,
            });
            applyEvent(view, event);
            events.push({ t, event });
          }
      };
      for (const frame of fixture.frames) {
        fold(translator.translate(structuredClone(frame), frame.t), frame.t);
        fold(translator.tick(frame.t), frame.t);
      }
      view.itemSeqs = Object.fromEntries(view.itemOrder.map((item, index) => [item, index + 1]));
      all.push({ name: `${provider}/${file}`, view, events });
    }
  }
  return all;
}

/** What one client of `trims` receives for `message`, as text. */
const sent = (message: ServerMessage, trims: readonly string[] | undefined) =>
  new WireTrimmer(trims)
    .outgoing(message)
    .map((frame) => JSON.stringify(frame))
    .join("\n");

function snapshots(all: Session[]) {
  const sized = all
    .map((session) => ({
      session,
      bytes: JSON.stringify(session.view).length,
    }))
    .toSorted((a, b) => a.bytes - b.bytes);
  const typical = sized[Math.floor(sized.length / 2)];
  const large = sized.at(-1);
  console.log("\nThread snapshot, deflated (raw and deflated sizes)");
  for (const [label, entry] of [
    ["typical", typical],
    ["large", large],
  ] as const) {
    if (!entry) continue;
    const message: ServerMessage = {
      type: "snapshot",
      subscriptionId,
      seq: entry.session.view.seq,
      view: entry.session.view,
    };
    const items = Object.keys(entry.session.view.items).length;
    console.log(`  ${label}: ${entry.session.name} (${items} items)`);
    for (const [client, { trims }] of Object.entries(clients)) {
      const text = sent(message, trims);
      console.log(
        `    ${client.padEnd(30)} ${kb(text.length).padStart(9)} ${kb(deflated(text)).padStart(9)}`,
      );
    }
  }
  // An item page: the newest 200 items of the largest session.
  if (!large) return;
  const view = large.session.view;
  const page: ServerMessage = {
    type: "items.page",
    requestId: "page",
    seq: view.seq,
    threadId: view.thread.id,
    items: view.itemOrder.slice(-200).flatMap((item) => view.items[item] ?? []),
    itemsBefore: null,
  };
  console.log(`\nItem page (${large.session.name}, newest 200 items)`);
  for (const [client, { trims }] of Object.entries(clients)) {
    const text = sent(page, trims);
    console.log(
      `    ${client.padEnd(30)} ${kb(text.length).padStart(9)} ${kb(deflated(text)).padStart(9)}`,
    );
  }
}

function deltas(all: Session[]) {
  const encoder = new WireEncoder();
  const total = { whole: 0, short: 0, text: 0, count: 0, item: { whole: 0, trimmed: 0 } };
  for (const { events } of all)
    for (const { event } of events) {
      const message: ServerMessage = {
        type: "events",
        subscriptionId,
        afterSeq: event.seq - 1,
        throughSeq: event.seq,
        events: [event],
      };
      if (event.payload.type === "item.delta") {
        total.count++;
        total.text += Buffer.byteLength(event.payload.append);
        total.whole += encoder.encodedBytes(message);
        total.short += encoder.encodedBytes(message, { rawOnDemand: true, shortDeltas: true });
      } else if (event.payload.type === "item.updated") {
        total.item.whole += encoder.encodedBytes(message);
        total.item.trimmed += encoder.encodedBytes(message, {
          rawOnDemand: true,
          shortDeltas: true,
        });
      }
    }
  const per = (bytes: number) => (bytes / total.count).toFixed(0);
  console.log(`\nStreamed deltas (${total.count}, each its own events message)`);
  console.log(`    text per delta                 ${per(total.text)} B`);
  console.log(`    old framing                    ${per(total.whole)} B per message`);
  console.log(`    short-deltas                   ${per(total.short)} B per message`);
  console.log(
    `\nitem.updated, uncompressed: ${kb(total.item.whole)} whole, ${kb(total.item.trimmed)} raw-on-demand`,
  );
}

/**
 * A remote socket on a link that drains `bytesPerSecond`, its backlog as `bufferedAmount`, with
 * the outbox's hold timers on a virtual clock. Returns frames sent and their sizes.
 */
function slowLink(events: Session["events"], remote: boolean, bytesPerSecond: number) {
  let now = 0;
  let queued = 0;
  let drainedAt = 0;
  const timers: { at: number; run(): void; live: boolean }[] = [];
  const drain = () => {
    queued = Math.max(0, queued - ((now - drainedAt) * bytesPerSecond) / 1000);
    drainedAt = now;
  };
  const frames: string[] = [];
  const socket = {
    readyState: 1 as const,
    get bufferedAmount() {
      drain();
      return queued;
    },
    isPaused: false,
    send(data: string, ...rest: unknown[]) {
      drain();
      frames.push(data);
      queued += Buffer.byteLength(data);
      const done = rest.find((value) => typeof value === "function") as (() => void) | undefined;
      done?.();
    },
    close() {},
    terminate() {},
    pause() {},
    resume() {},
    on() {},
    once() {},
    off() {},
  };
  const outbox = new Outbox(
    socket as unknown as MainSocket,
    defaultPressure,
    () => now,
    new WireEncoder(),
    (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  );
  outbox.packFrames(remote);
  outbox.shapeEvents({ rawOnDemand: true, shortDeltas: true });
  const runTimers = (until: number) => {
    for (;;) {
      const next = timers
        .filter((timer) => timer.live && timer.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.run();
    }
    now = until;
  };
  for (const { t, event } of events) {
    runTimers(t);
    outbox.send({
      type: "events",
      subscriptionId,
      afterSeq: event.seq - 1,
      throughSeq: event.seq,
      events: [event],
    });
  }
  runTimers(Number.MAX_SAFE_INTEGER);
  return frames;
}

const isDeltaLine = (line: string) => line.includes('"d":[') || line.includes('"item.delta"');
const size = (frame: string) => Buffer.byteLength(frame);

function linkBatching(all: Session[]) {
  const busiest = all.toSorted(
    (a, b) =>
      b.events.filter((entry) => entry.event.payload.type === "item.delta").length -
      a.events.filter((entry) => entry.event.payload.type === "item.delta").length,
  )[0];
  if (!busiest) return;
  // Recorded frames often share a timestamp; each event here arrives `spacing` ms after the
  // one before, as a provider streams them.
  for (const [pace, spacing, bytesPerSecond] of [
    ["recorded pace", 0, 50 * 1024],
    ["one event per 2 ms (a burst)", 2, 50 * 1024],
    ["one event per 2 ms on 10 KB/s", 2, 10 * 1024],
  ] as const) {
    console.log(
      `\nDeltas per frame, ${pace}, ${kb(bytesPerSecond)}/s remote link (${busiest.name})`,
    );
    const events = busiest.events.map((entry, index) =>
      Object.assign({}, entry, { t: spacing ? index * spacing : entry.t * 4 + index }),
    );
    const count = events.filter((entry) => entry.event.payload.type === "item.delta").length;
    for (const [label, remote] of [
      ["16 ms hold (before)", false],
      ["link-aware hold", true],
    ] as const) {
      const frames = slowLink(events, remote, bytesPerSecond);
      const deltaFrames = frames.filter((frame) => frame.split("\n").some(isDeltaLine));
      const inFrames = deltaFrames.reduce(
        (sum, frame) => sum + frame.split("\n").filter(isDeltaLine).length,
        0,
      );
      const wire = (frame: string) =>
        size(frame) < compressionThresholdBytes ? size(frame) : deflated(frame);
      const small = frames.filter((frame) => size(frame) < compressionThresholdBytes);
      const smallBytes = small.reduce((sum, frame) => sum + size(frame), 0);
      const smallDeflated = small.reduce(
        (sum, frame) => sum + Math.min(size(frame), deflated(frame)),
        0,
      );
      const total = frames.reduce((sum, frame) => sum + wire(frame), 0);
      console.log(
        `    ${label.padEnd(20)} ${count} deltas in ${deltaFrames.length} frames, ${(inFrames / Math.max(1, deltaFrames.length)).toFixed(2)} per frame; ${frames.length} frames, ${kb(total)} sent`,
      );
      console.log(
        `      frames under the ${compressionThresholdBytes} B threshold: ${small.length}, ${kb(smallBytes)}; deflated alone: ${kb(smallDeflated)}`,
      );
    }
  }
}

const all = await sessions();
console.log(`${all.length} recorded sessions`);
snapshots(all);
deltas(all);
linkBatching(all);

import { describe, expect, it } from "vitest";
import { EgressRouter, type EgressUnit } from "./egress.ts";
import { encodeEgress, encodeEgressEnd, type MediaFrame } from "./frame.ts";
import {
  pictureIngestMissing,
  drainMs,
  failedReason,
  IngestSources,
  maxIngestReopens,
  restartingReason,
  type IngestAddress,
  type IngestProducer,
} from "./ingest-sources.ts";
import { mediaRoutes, type RouteCapabilities, type SourceKind } from "./routes.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

const capabilities: RouteCapabilities = {
  ingest: ["tab", "tab-pictures", "screen", "simulator"],
  delivery: false,
};

function unitFrame(mark: number): MediaFrame {
  return {
    kind: 1,
    flags: 1,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 2,
    encode: 1,
    epoch: 0,
    codecString: "avc1.42E01F",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array([mark]),
  };
}

/** The daemon's sources with ace-media faked at its control lane and egress lane. */
function world() {
  const state = {
    why: undefined as string | undefined,
    settings: {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    } as MediaSettings,
    health: "healthy" as MediaHealth,
    /** What this build can stream into ace-media: emptied, a kind's route leaves it. */
    capabilities,
    up: true,
    needs: 0,
    /** The running ace-media's agreed features (`ready.features`). */
    features: ["source.ingest", "source.sync", "picture-ingest", "privacy-open"] as string[],
  };
  const sent: { message: ToMedia; payload?: Uint8Array }[] = [];
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  let ids = 0;
  let bytes = 0;
  const routes = () => mediaRoutes(state.settings, state.health, state.capabilities);
  const router = new EgressRouter((kind) => routes()[kind]);
  const sources = new IngestSources({
    port: {
      send: (message, payload) => {
        if (!state.up) return false;
        sent.push({ message, ...(payload ? { payload } : {}) });
        return true;
      },
      ingest: () => (state.up ? { socket: "/tmp/i.sock", websocketPort: 4000 } : undefined),
      need: () => {
        state.needs++;
        return () => void state.needs--;
      },
      speaks: (feature) => state.features.includes(feature),
    },
    router,
    routes,
    settings: () => state.settings,
    capabilities: () => state.capabilities,
    randomBytes: (length) => new Uint8Array(length).fill(++bytes),
    id: () => `s${++ids}`,
    why: () => state.why,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.splice(0))
      if (timer.cancelled) continue;
      else if (timer.at <= now) timer.run();
      else timers.push(timer);
  };
  const opened = () =>
    sent.flatMap(({ message }) => (message.type === "source.open" ? [message] : []));
  const types = () => sent.map(({ message }) => message.type);
  const closed = () =>
    sent.flatMap(({ message }) => (message.type === "source.close" ? [message.source] : []));
  const status = (
    source: string,
    to: "starting" | "playing" | "retrying" | "ended",
    reason?: string,
  ) =>
    sources.message({
      type: "source.status",
      source,
      status: to,
      ...(reason ? { reason } : {}),
      ...(to === "retrying" ? { attempts: 1 } : {}),
    });
  return { state, sent, sources, router, advance, opened, types, closed, status };
}

function producer(kind: SourceKind = "tab", source = "p") {
  const points: (IngestAddress | undefined)[] = [];
  const units: EgressUnit[] = [];
  const ended: [string, boolean][] = [];
  const refused: (string | undefined)[] = [];
  const keyframes: number[] = [];
  const events: string[] = [];
  const stops: string[] = [];
  const p: IngestProducer = {
    source,
    kind,
    origin: { kind } as IngestProducer["origin"],
    threadId: "t1",
    epoch: () => 0,
    consumers: {
      deliver: (unit) => void units.push(unit),
    },
    point: (address) => {
      events.push(address ? "point" : "unpoint");
      points.push(address);
      return Promise.resolve();
    },
    keyframe: (encode) => void keyframes.push(encode),
    pathEnded: (path, interrupted) => {
      events.push("ended");
      ended.push([path, interrupted]);
    },
    refused: (reason) => void refused.push(reason),
    stopped: (reason) => void stops.push(reason),
  };
  return { p, points, units, ended, refused, keyframes, events, stops };
}

/** The open a JPEG source sends to an ace-media that agreed to `features`. */
function jpegOpen(features: string[], isPrivate: boolean) {
  const w = world();
  w.state.features = features;
  w.sources.add({ ...producer("tab-pictures").p, private: () => isPrivate });
  return w.opened()[0];
}

describe("IngestSources", () => {
  it("opens a routed source with its token and handle, and points the producer once ace-media has it", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    expect(w.opened()).toEqual([
      expect.objectContaining({ source: "s1", handle: 1, threadId: "t1" }),
    ]);
    expect(w.types()).toEqual(["source.open", "source.egress"]);
    expect(l.points).toEqual([]);
    w.status("s1", "starting");
    expect(l.points[0]).toMatchObject({
      url: "ws://127.0.0.1:4000/ingest",
      socket: "/tmp/i.sock",
      path: "s1",
      epoch: 0,
    });
    // The producer's copy of the token is the one ace-media was given.
    expect(l.points[0]?.token).toEqual(w.sent[0]?.payload);
    expect(w.state.needs).toBe(1);
  });

  it("keeps a source with the daemon while its kind can't stream into ace-media, without starting it", () => {
    const w = world();
    w.state.capabilities = { ...w.state.capabilities, ingest: [] };
    const l = producer();
    w.sources.add(l.p);
    expect(w.sent).toEqual([]);
    expect(w.state.needs).toBe(0);
  });

  it("wants ace-media while it starts, and opens the source once it is up", () => {
    const w = world();
    w.state.up = false;
    w.state.health = "restarting";
    const l = producer();
    w.sources.add(l.p);
    expect(w.state.needs).toBe(1);
    expect(w.opened()).toEqual([]);
    w.state.up = true;
    w.state.health = "healthy";
    w.sources.replay();
    expect(w.opened()).toHaveLength(1);
  });

  it("units on a backed-up egress lane still arrive after their status overtook them; the handle closes only at the end marker", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.router.push(encodeEgress(1, 0, unitFrame(1)));
    // ace-media stops answering (its route stops the producer); its status about the producer's end comes first,
    // long before the lane carrying its last units drains.
    w.state.capabilities = { ...w.state.capabilities, ingest: [] };
    w.sources.routesChanged(["tab"]);
    expect(l.points.at(-1)).toBeUndefined();
    w.status("s1", "ended");
    w.advance(drainMs - 1);
    w.router.push(encodeEgress(1, 1, unitFrame(2)));
    w.router.push(encodeEgress(1, 2, unitFrame(3)));
    expect(l.units.map((u) => u.frame.payload[0])).toEqual([1, 2, 3]);
    expect(w.closed()).toEqual([]);
    expect(l.ended).toEqual([]);
    w.router.push(encodeEgressEnd(1, 3, false));
    expect(l.ended).toEqual([["s1", false]]);
    expect(w.closed()).toEqual(["s1"]);
    w.router.push(encodeEgress(1, 3, unitFrame(4)));
    expect(l.units).toHaveLength(3);
    // The drain's own hold is released, and a kind ace-media can't take holds nothing.
    expect(w.state.needs).toBe(0);
  });

  it("a drain whose end marker never comes is reported interrupted, never clean", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.state.capabilities = { ...w.state.capabilities, ingest: [] };
    w.sources.routesChanged(["tab"]);
    w.advance(drainMs - 1);
    expect(l.ended).toEqual([]);
    w.advance(1);
    expect(l.ended).toEqual([["s1", true]]);
    expect(w.closed()).toEqual(["s1"]);
  });

  it("the producer is stopped before its old path is reported ended", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.state.capabilities = { ...w.state.capabilities, ingest: [] };
    w.sources.routesChanged(["tab"]);
    w.router.push(encodeEgressEnd(1, 0, false));
    expect(l.events).toEqual(["point", "unpoint", "ended"]);
  });

  it("ace-media exiting stops every producer first, then ends its paths as cut; a restart gives fresh tokens and handles", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    const first = l.points[0]?.token.slice();
    w.state.up = false;
    w.state.health = "restarting";
    w.sources.exited();
    expect(l.events).toEqual(["point", "unpoint", "ended"]);
    expect(l.ended).toEqual([["s1", true]]);
    w.state.up = true;
    w.state.health = "healthy";
    w.sources.replay();
    w.status("s2", "starting");
    expect(l.points.at(-1)?.token).not.toEqual(first);
    expect(w.opened().map((o) => o.handle)).toEqual([1, 2]);
  });

  it("a producer whose connection dropped is reopened with a new token while its old handle drains to its marker", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.status("s1", "retrying");
    expect(w.opened().map((o) => o.source)).toEqual(["s1", "s2"]);
    w.router.push(encodeEgress(1, 0, unitFrame(9)));
    expect(l.units.map((u) => u.frame.payload[0])).toEqual([9]);
    w.router.push(encodeEgressEnd(1, 1, true));
    expect(l.ended).toEqual([["s1", true]]);
    w.status("s2", "starting");
    expect(l.points.at(-1)).toMatchObject({ path: "s2" });
  });

  it("gives up after a few reconnects in a row, saying so, until its route changes again", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    for (let i = 0; i <= maxIngestReopens; i++) {
      const id = `s${i + 1}`;
      w.status(id, "starting");
      w.status(id, "retrying");
    }
    expect(w.opened()).toHaveLength(maxIngestReopens + 1);
    expect(l.stops).toEqual([failedReason]);
    w.sources.routesChanged(["tab"]);
    expect(w.opened()).toHaveLength(maxIngestReopens + 2);
  });

  it("a Simulator ace-media reads itself is closed there at once when its route stops it, so its reader drains and the end marker follows its last unit", () => {
    const w = world();
    const l = producer("simulator");
    w.sources.add(l.p);
    w.status("s1", "starting");
    expect(l.points.at(-1)).toBeDefined();
    w.state.capabilities = { ...w.state.capabilities, ingest: [] };
    w.sources.routesChanged(["simulator"]);
    // No producer of its own to drain: only ace-media's close ends its reading.
    expect(w.closed()).toEqual(["s1"]);
    w.router.push(encodeEgressEnd(1, 0, false));
    expect(l.ended.at(-1)).toEqual(["s1", false]);
  });

  it("a JPEG source's open says it is private only when it is, and only to a build that reads it", () => {
    const all = ["source.ingest", "source.sync", "picture-ingest", "privacy-open"];
    expect(jpegOpen(all, true)).toMatchObject({ private: true });
    expect(jpegOpen(all, false)).not.toHaveProperty("private");
    // A build with picture-ingest but no privacy-open has a strict decoder: no field for it.
    expect(jpegOpen(["source.ingest", "source.sync", "picture-ingest"], true)).not.toHaveProperty(
      "private",
    );
  });

  it("epochs announced while a JPEG source has no open in ace-media are never kept for one", () => {
    const w = world();
    // An ace-media too old for pictures: the source never opens there.
    w.state.features = ["source.ingest", "source.sync"];
    let epoch = 0;
    const source = w.sources.add({ ...producer("tab-pictures").p, epoch: () => epoch });
    for (epoch = 1; epoch <= 3; epoch++) source.epoch?.(epoch, epoch % 2 === 0);
    // A newer one starts: the open carries the current epoch, and nothing older follows it.
    epoch = 3;
    w.state.features = ["source.ingest", "source.sync", "picture-ingest", "privacy-open"];
    w.sources.exited();
    w.sources.replay();
    w.status("s1", "starting");
    expect(w.opened()).toMatchObject([{ epoch: 3 }]);
    expect(w.sent.some(({ message }) => message.type === "source.epoch")).toBe(false);
  });

  it("epochs announced before ace-media answers a JPEG source's open go after it in order, none merged", () => {
    const w = world();
    const l = producer("tab-pictures");
    const source = w.sources.add(l.p);
    // Opened public in epoch 0; private 1 → public 2 → private 3 before ace-media answers.
    source.epoch?.(1, false);
    source.epoch?.(2, true);
    source.epoch?.(3, false);
    w.status("s1", "starting");
    expect(
      w.sent.flatMap(({ message }) =>
        message.type === "source.epoch" ? [[message.epoch, message.followsPrivate]] : [],
      ),
    ).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it("a JPEG source opens with its privacy, and an epoch announced before ace-media answers the open is applied after it", () => {
    const w = world();
    const l = producer("tab-pictures");
    let state = { epoch: 3, private: true };
    const source = w.sources.add({
      ...l.p,
      epoch: () => state.epoch,
      private: () => state.private,
    });
    expect(w.opened()[0]).toMatchObject({ source: "s1", epoch: 3, private: true });
    // The tab goes public before ace-media answered the open: held, not sent ahead of it.
    state = { epoch: 4, private: false };
    source.epoch?.(4, true);
    const epochs = () =>
      w.sent.flatMap(({ message }) => (message.type === "source.epoch" ? [message] : []));
    expect(epochs()).toEqual([]);
    w.status("s1", "starting");
    expect(epochs()).toEqual([
      { type: "source.epoch", source: "s1", seq: 0, epoch: 4, followsPrivate: true },
    ]);
    // Once answered, each goes at once.
    source.epoch?.(5, false);
    expect(epochs().map((e) => e.epoch)).toEqual([4, 5]);
    // A restart opens in the state the tab is in now, with nothing stale replayed.
    state = { epoch: 5, private: true };
    w.sources.exited();
    w.sources.replay();
    expect(w.opened().at(-1)).toMatchObject({ epoch: 5, private: true });
    w.status("s2", "starting");
    expect(epochs().map((e) => e.epoch)).toEqual([4, 5]);
  });

  it("an ace-media too old to encode pictures off the ingest leaves only JPEG sources off, saying why, until a newer one runs", () => {
    const w = world();
    w.state.features = ["source.ingest", "source.sync"];
    const pictures = producer("tab-pictures", "jpeg");
    const tab = producer("tab", "tab");
    w.sources.add(pictures.p);
    w.sources.add(tab.p);
    // The tab's own video goes on; the JPEG source never opens there.
    expect(w.opened().map((o) => o.origin.kind)).toEqual(["tab"]);
    expect(pictures.stops).toEqual([pictureIngestMissing]);
    expect(tab.stops).toEqual([]);
    // A newer ace-media starts: the JPEG source opens there.
    w.state.features = ["source.ingest", "source.sync", "picture-ingest"];
    w.sources.exited();
    w.sources.replay();
    expect(w.opened().map((o) => o.origin.kind)).toContain("tab-pictures");
  });

  it("a source ace-media ended with a reason stays stopped until its route changes or ace-media starts again", () => {
    const w = world();
    const l = producer("tab-pictures");
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.status("s1", "ended", "encoder-unavailable");
    expect(l.refused).toEqual(["encoder-unavailable"]);
    expect(l.points.at(-1)).toBeUndefined();
    expect(w.opened()).toHaveLength(1);
    w.sources.routesChanged(["tab-pictures"]);
    expect(w.opened()).toHaveLength(2);
    w.status("s2", "starting");
    w.status("s2", "ended", "encoder-unavailable");
    // A new ace-media is asked again: the daemon has no other path to fall back on.
    w.sources.replay();
    expect(w.opened()).toHaveLength(3);
  });

  it("a JPEG source's encodes are kept and sent again after a restart, and leaving waits for the marker after its last picture", () => {
    const w = world();
    const l = producer("tab-pictures");
    const source = w.sources.add(l.p);
    const encodes = [
      { id: 1, codec: "avc1.42E01F", width: 640, height: 400, fps: 30, bitrate: 2_000_000 },
    ];
    source.encodes(encodes);
    w.status("s1", "starting");
    w.sources.exited();
    w.sources.replay();
    const resent = w.sent.filter(({ message }) => message.type === "source.encodes");
    expect(resent.map(({ message }) => message)).toEqual([
      { type: "source.encodes", source: "s1", encodes },
      { type: "source.encodes", source: "s2", encodes },
    ]);
    // Leaving, the producer is told to stop: it writes its pending picture and its ingest end.
    // ace-media's marker follows the encoder's last unit, and only then is the source closed.
    w.status("s2", "starting");
    w.state.capabilities = { ...w.state.capabilities, ingest: [] };
    w.sources.routesChanged(["tab-pictures"]);
    expect(l.points.at(-1)).toBeUndefined();
    expect(w.closed()).toEqual([]);
    w.router.push(encodeEgressEnd(2, 0, false));
    expect(l.ended.at(-1)).toEqual(["s2", false]);
    expect(w.closed()).toEqual(["s2"]);
  });

  it("a JPEG source whose marker never comes after it is told to stop is closed at the drain limit, interrupted", () => {
    const w = world();
    const l = producer("tab-pictures");
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.state.health = "restarting";
    w.sources.routesChanged(["tab-pictures"]);
    w.advance(drainMs - 1);
    expect(w.closed()).toEqual([]);
    w.advance(1);
    expect(w.closed()).toEqual(["s1"]);
    expect(l.ended.at(-1)).toEqual(["s1", true]);
  });

  it("what a producer encodes reaches ace-media after its open, now and on every open after a restart", () => {
    const w = world();
    const l = producer("screen");
    const source = w.sources.add(l.p);
    source.codecs(["avc1.42E033"]);
    source.codecs(["avc1.42E033", "hvc1.1.6.L153.B0"]);
    w.sources.exited();
    source.codecs(["avc1.42E033"]);
    w.sources.replay();
    const told = w.sent.flatMap(({ message }) =>
      message.type === "source.codecs" || message.type === "source.open"
        ? [
            `${message.type} ${message.source}${"codecs" in message ? ` ${message.codecs.join(",")}` : ""}`,
          ]
        : [],
    );
    expect(told).toEqual([
      "source.open s1",
      "source.codecs s1 avc1.42E033",
      "source.codecs s1 avc1.42E033,hvc1.1.6.L153.B0",
      "source.open s2",
      "source.codecs s2 avc1.42E033",
    ]);
  });

  it("closing a JPEG source keeps its handle until the marker after its encoder's last units, or the drain limit", () => {
    for (const marker of [true, false]) {
      const w = world();
      const l = producer("tab-pictures");
      const source = w.sources.add(l.p);
      w.status("s1", "starting");
      source.close();
      // The capture finishes its writer; ace-media's encoder still holds the last pictures.
      expect(w.closed()).toEqual([]);
      w.router.push(encodeEgress(1, 0, unitFrame(1)));
      expect(l.units).toHaveLength(1);
      if (marker) {
        w.router.push(encodeEgressEnd(1, 1, false));
        expect(l.ended.at(-1)).toEqual(["s1", false]);
      } else {
        w.advance(drainMs);
        expect(l.ended.at(-1)).toEqual(["s1", true]);
      }
      expect(w.closed()).toEqual(["s1"]);
      expect(w.state.needs).toBe(0);
    }
  });

  it("asks the producer for a keyframe when ace-media does, and closing ends everything", () => {
    const w = world();
    const l = producer();
    const source = w.sources.add(l.p);
    w.status("s1", "starting");
    w.sources.message({ type: "source.keyframe", source: "s1", encode: 4, reason: "drop" });
    expect(l.keyframes).toEqual([4]);
    source.close();
    expect(w.closed()).toEqual(["s1"]);
    expect(w.state.needs).toBe(0);
  });
});

it("ace-media's plan reaches the producer streaming to it, and no other", () => {
  const w = world();
  const wants: unknown[] = [];
  const l = producer();
  w.sources.add({ ...l.p, want: (encodes) => void wants.push(encodes) });
  const encodes = [
    { id: 1, codec: "avc1.42E033", width: 320, height: 200, fps: 15, bitrate: 150_000 },
  ];
  // Not streaming to ace-media yet: the plan waits for it.
  w.sources.message({ type: "source.want", source: "s1", encodes });
  expect(wants).toEqual([]);
  // Pointed there: the plan ace-media made meanwhile follows the address, unasked again.
  w.status("s1", "starting");
  expect(wants).toEqual([encodes]);
  w.sources.message({ type: "source.want", source: "s1", encodes });
  expect(wants).toEqual([encodes, encodes]);
  // A plan for another source's id is not this producer's.
  w.sources.message({ type: "source.want", source: "other", encodes });
  expect(wants).toHaveLength(2);
});

describe("a stopped source says why, so its live views never go blank without a reason", () => {
  it("ace-media exiting tells each streaming producer it is restarting, and a restart streams again", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.state.up = false;
    w.state.health = "restarting";
    w.sources.exited();
    expect(l.stops).toEqual([restartingReason]);
    w.state.up = true;
    w.state.health = "healthy";
    w.sources.replay();
    w.status("s2", "starting");
    expect(l.points.at(-1)).toMatchObject({ path: "s2" });
  });

  it("an unavailable ace-media's reason reaches a source added meanwhile and the ones it stopped", () => {
    const w = world();
    const streaming = producer("tab", "a");
    w.sources.add(streaming.p);
    w.status("s1", "starting");
    w.state.health = "unavailable";
    w.state.why = "ace-media is unavailable: crashed 5 times";
    w.sources.routesChanged(["tab"]);
    expect(streaming.stops).toEqual(["ace-media is unavailable: crashed 5 times"]);
    const late = producer("screen", "b");
    w.sources.add(late.p);
    expect(late.stops).toEqual(["ace-media is unavailable: crashed 5 times"]);
    expect(late.points).toEqual([]);
  });

  it("a source added while ace-media is only starting waits without a word", () => {
    const w = world();
    w.state.up = false;
    w.state.health = "restarting";
    const l = producer();
    w.sources.add(l.p);
    expect(l.stops).toEqual([]);
  });

  it("a source ace-media ended says ace-media's reason", () => {
    const w = world();
    const l = producer("tab-pictures");
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.status("s1", "ended", "encoder-unavailable");
    expect(l.stops).toEqual(["encoder-unavailable"]);
  });
});

it("a source waiting before ace-media's first start hears every failed start's reason, once each, and is pointed once one starts", async () => {
  const w = world();
  w.state.up = false;
  w.state.health = "restarting";
  const l = producer();
  w.sources.add(l.p);
  expect(l.stops).toEqual([]);
  // Each launch dies before it is ready: the daemon's state for the source never changed.
  w.state.why = restartingReason;
  w.sources.exited();
  w.sources.exited();
  expect(l.stops).toEqual([restartingReason]);
  w.state.why = "ace-media is unavailable: crash loop";
  w.sources.exited();
  expect(l.stops).toEqual([restartingReason, "ace-media is unavailable: crash loop"]);
  w.state.why = undefined;
  w.state.up = true;
  w.state.health = "healthy";
  w.sources.replay();
  w.status("s1", "starting");
  expect(l.points.at(-1)).toMatchObject({ path: "s1" });
  // Stopped again later: the same reason is news again.
  w.state.up = false;
  w.state.health = "restarting";
  w.state.why = restartingReason;
  w.sources.exited();
  expect(l.stops.at(-1)).toBe(restartingReason);
  expect(l.stops).toHaveLength(3);
});

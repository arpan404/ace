import { describe, expect, it } from "vitest";
import { EgressRouter, type EgressUnit } from "./egress.ts";
import { encodeEgress, encodeEgressEnd, type MediaFrame } from "./frame.ts";
import {
  drainMs,
  IngestSources,
  maxIngestReopens,
  type IngestAddress,
  type IngestProducer,
} from "./ingest-sources.ts";
import { mediaRoutes, type RouteCapabilities, type SourceKind } from "./routes.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

const capabilities: RouteCapabilities = {
  ingest: ["tab", "tab-pictures", "screen", "simulator"],
  recordings: false,
  stills: false,
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
    settings: {
      encode: "auto",
      delivery: "legacy",
      recordings: "legacy",
      stills: "legacy",
    } as MediaSettings,
    health: "healthy" as MediaHealth,
    up: true,
    needs: 0,
  };
  const sent: { message: ToMedia; payload?: Uint8Array }[] = [];
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  let ids = 0;
  let bytes = 0;
  const routes = () => mediaRoutes(state.settings, state.health, capabilities);
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
    },
    router,
    routes,
    settings: () => state.settings,
    capabilities: () => capabilities,
    randomBytes: (length) => new Uint8Array(length).fill(++bytes),
    id: () => `s${++ids}`,
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
  const p: IngestProducer = {
    source,
    kind,
    origin: { kind } as IngestProducer["origin"],
    threadId: "t1",
    epoch: () => 0,
    consumers: {
      deliver: (unit) => void units.push(unit),
      record: () => {},
      still: () => {},
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
  };
  return { p, points, units, ended, refused, keyframes, events };
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

  it("keeps a source with the daemon while its setting is legacy, without starting ace-media", () => {
    const w = world();
    w.state.settings = { ...w.state.settings, encode: "legacy" };
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
    // The route leaves ace-media; ace-media's status about the producer's end comes first,
    // long before the lane carrying its last units drains.
    w.state.settings = { ...w.state.settings, encode: "legacy" };
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
    expect(w.state.needs).toBe(0);
  });

  it("a drain whose end marker never comes is reported interrupted, never clean", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.routesChanged(["tab"]);
    w.advance(drainMs - 1);
    expect(l.ended).toEqual([]);
    w.advance(1);
    expect(l.ended).toEqual([["s1", true]]);
    expect(w.closed()).toEqual(["s1"]);
  });

  it("the producer is pointed back before its old path is reported ended", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.routesChanged(["tab"]);
    w.router.push(encodeEgressEnd(1, 0, false));
    expect(l.events).toEqual(["point", "unpoint", "ended"]);
  });

  it("ace-media exiting points every producer back first, then ends its paths as cut; a restart gives fresh tokens and handles", () => {
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

  it("gives up after a few reconnects in a row, until its route changes again", () => {
    const w = world();
    const l = producer();
    w.sources.add(l.p);
    for (let i = 0; i <= maxIngestReopens; i++) {
      const id = `s${i + 1}`;
      w.status(id, "starting");
      w.status(id, "retrying");
    }
    expect(w.opened()).toHaveLength(maxIngestReopens + 1);
    w.sources.routesChanged(["tab"]);
    expect(w.opened()).toHaveLength(maxIngestReopens + 2);
  });

  it("a Simulator ace-media reads itself is closed there at once when it moves back, so its reader drains and the end marker follows its last unit", () => {
    const w = world();
    const l = producer("simulator");
    w.sources.add(l.p);
    w.status("s1", "starting");
    expect(l.points.at(-1)).toBeDefined();
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.routesChanged(["simulator"]);
    // No producer of its own to drain: only ace-media's close ends its reading.
    expect(w.closed()).toEqual(["s1"]);
    w.router.push(encodeEgressEnd(1, 0, false));
    expect(l.ended.at(-1)).toEqual(["s1", false]);
  });

  it("a source ace-media ended with a reason stays on the daemon until its route changes", () => {
    const w = world();
    const l = producer("tab-pictures");
    w.sources.add(l.p);
    w.status("s1", "starting");
    w.status("s1", "ended", "encoder-unavailable");
    expect(l.refused).toEqual(["encoder-unavailable"]);
    expect(l.points.at(-1)).toBeUndefined();
    w.sources.replay();
    expect(w.opened()).toHaveLength(1);
    w.sources.routesChanged(["tab-pictures"]);
    expect(w.opened()).toHaveLength(2);
  });

  it("a JPEG source's encodes are kept and sent again after a restart, its pictures carry their text, and leaving closes it at once", () => {
    const w = world();
    const l = producer("tab-pictures");
    const source = w.sources.add(l.p);
    const encodes = [
      { id: 1, codec: "avc1.42E01F", width: 640, height: 400, fps: 30, bitrate: 2_000_000 },
    ];
    source.encodes(encodes);
    w.status("s1", "starting");
    expect(source.picture("aGVsbG8=", 3)).toBe(true);
    const picture = w.sent.find(({ message }) => message.type === "source.picture");
    expect(picture?.message).toMatchObject({ source: "s1", ageMs: 3 });
    expect(new TextDecoder().decode(picture?.payload)).toBe("aGVsbG8=");
    w.sources.exited();
    expect(source.picture("aGVsbG8=")).toBe(false);
    w.sources.replay();
    const resent = w.sent.filter(({ message }) => message.type === "source.encodes");
    expect(resent.map(({ message }) => message)).toEqual([
      { type: "source.encodes", source: "s1", encodes },
      { type: "source.encodes", source: "s2", encodes },
    ]);
    // ace-media reads these pictures itself: the close is ordered after the last one.
    w.status("s2", "starting");
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.routesChanged(["tab-pictures"]);
    expect(w.closed()).toEqual(["s2"]);
    w.router.push(encodeEgressEnd(2, 0, false));
    expect(l.ended.at(-1)).toEqual(["s2", false]);
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

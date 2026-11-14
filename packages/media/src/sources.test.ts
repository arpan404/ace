import { describe, expect, it } from "vitest";
import { EgressRouter, type EgressUnit } from "./egress.ts";
import { encodeEgress, type MediaFrame } from "./frame.ts";
import { mediaRoutes, type RouteCapabilities, type SourceKind } from "./routes.ts";
import { drainGraceMs, drainMs, MediaSources, type IngestTarget } from "./sources.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

const capabilities: RouteCapabilities = {
  ingest: ["tab", "tab-pictures"],
  recordings: false,
  stills: false,
  delivery: false,
};

function unitFrame(payload: number): MediaFrame {
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
    payload: new Uint8Array([payload]),
  };
}

/** A daemon around `MediaSources` with ace-media faked at the control lane. */
function world() {
  const state = {
    settings: { encode: "auto", delivery: "legacy", recordings: "legacy", stills: "legacy" } as
      | MediaSettings
      | { encode: "legacy"; delivery: "legacy"; recordings: "legacy"; stills: "legacy" },
    health: "healthy" as MediaHealth,
    up: true,
    needs: 0,
  };
  const sent: { message: ToMedia; payload?: Uint8Array }[] = [];
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  let ids = 0;
  let bytes = 0;
  const route = (kind: SourceKind) => mediaRoutes(state.settings, state.health, capabilities)[kind];
  let sources: MediaSources;
  const egress = new EgressRouter((kind) => sources.egressRoute(kind));
  sources = new MediaSources({
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
    route,
    wanted: (kind) => state.settings.encode === "auto" && capabilities.ingest.includes(kind),
    egress,
    randomBytes: (length) => new Uint8Array(length).fill(++bytes),
    id: () => `s${++ids}`,
    setTimeout: (run, ms) => {
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
  return { state, sent, sources, egress, advance, opened, types };
}

function listener() {
  const targets: (IngestTarget | undefined)[] = [];
  const units: EgressUnit[] = [];
  const ended: (string | undefined)[] = [];
  return {
    targets,
    units,
    ended,
    events: {
      target: (target: IngestTarget | undefined) => void targets.push(target),
      unit: (unit: EgressUnit) => void units.push(unit),
      ended: (reason: string | undefined) => void ended.push(reason),
    },
  };
}

describe("MediaSources", () => {
  it("opens a routed source with its token and handle, and points the producer at the ingest", () => {
    const w = world();
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events, { threadId: "t1", tabId: "tab-1" });
    expect(w.opened()).toEqual([
      expect.objectContaining({ source: "s1", handle: 1, threadId: "t1", tabId: "tab-1" }),
    ]);
    expect(w.types()).toEqual(["source.open", "source.egress"]);
    expect(l.targets).toHaveLength(1);
    expect(l.targets[0]).toMatchObject({ url: "ws://127.0.0.1:4000/ingest", epoch: 0 });
    // The producer's copy of the token is the one ace-media was given.
    expect(l.targets[0]?.token).toEqual(w.sent[0]?.payload);
    expect(w.state.needs).toBe(1);
  });

  it("keeps a source with the daemon while its kind's setting is legacy, without starting ace-media", () => {
    const w = world();
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events);
    expect(w.sent).toEqual([]);
    expect(l.targets).toEqual([]);
    expect(w.state.needs).toBe(0);
  });

  it("wants ace-media while it starts, and opens the source once it is up", () => {
    const w = world();
    w.state.up = false;
    w.state.health = "restarting";
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events);
    expect(w.state.needs).toBe(1);
    expect(l.targets).toEqual([]);
    w.state.up = true;
    w.state.health = "healthy";
    w.sources.replay();
    expect(l.targets).toHaveLength(1);
  });

  it("delivers egress units by handle, and a closed source's units are dropped", () => {
    const w = world();
    const l = listener();
    const source = w.sources.open("tab", { kind: "tab" }, l.events);
    w.egress.push(encodeEgress(1, 0, unitFrame(7)));
    expect(l.units.map((u) => u.frame.payload[0])).toEqual([7]);
    source.close();
    w.egress.push(encodeEgress(1, 1, unitFrame(8)));
    expect(l.units).toHaveLength(1);
    expect(w.types().at(-1)).toBe("source.close");
    expect(w.state.needs).toBe(0);
  });

  it("a route flip back to the daemon still delivers units in flight until the producer's end, then closes", () => {
    const w = world();
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events);
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.routesChanged(["tab"]);
    expect(l.targets.at(-1)).toBeUndefined();
    expect(w.types()).not.toContain("source.close");
    // Sent before the producer heard: still delivered, once.
    w.egress.push(encodeEgress(1, 0, unitFrame(1)));
    w.sources.message({ type: "source.status", source: "s1", status: "ended" });
    w.egress.push(encodeEgress(1, 1, unitFrame(2)));
    expect(l.units.map((u) => u.frame.payload[0])).toEqual([1, 2]);
    expect(l.ended).toEqual([]);
    w.advance(drainGraceMs);
    expect(w.types().at(-1)).toBe("source.close");
    w.egress.push(encodeEgress(1, 2, unitFrame(3)));
    expect(l.units).toHaveLength(2);
    expect(w.state.needs).toBe(0);
  });

  it("a drain whose end never comes closes after its bound", () => {
    const w = world();
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events);
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.routesChanged(["tab"]);
    w.advance(drainMs - 1);
    expect(w.types()).not.toContain("source.close");
    w.advance(1);
    expect(w.types().at(-1)).toBe("source.close");
  });

  it("a flip to ace-media opens the source again with a new token", () => {
    const w = world();
    const l = listener();
    w.state.settings = { ...w.state.settings, encode: "legacy" };
    w.sources.open("tab", { kind: "tab" }, l.events);
    w.state.settings = { ...w.state.settings, encode: "auto" };
    w.sources.routesChanged(["tab"]);
    expect(l.targets).toHaveLength(1);
    expect(w.opened()).toHaveLength(1);
  });

  it("ace-media exiting sends every producer back at once, and its restart gives fresh tokens", () => {
    const w = world();
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events);
    const first = l.targets[0]?.token.slice();
    w.state.up = false;
    w.state.health = "restarting";
    w.sources.exited();
    expect(l.targets.at(-1)).toBeUndefined();
    w.state.up = true;
    w.state.health = "healthy";
    w.sources.replay();
    const second = l.targets.at(-1);
    expect(second?.token).toBeDefined();
    expect(second?.token).not.toEqual(first);
    expect(w.opened().map((o) => o.handle)).toEqual([1, 2]);
  });

  it("a producer that lost its connection is reopened with a new token, without a detour to the daemon", () => {
    const w = world();
    const l = listener();
    w.sources.open("tab", { kind: "tab" }, l.events);
    w.sources.message({ type: "source.status", source: "s1", status: "retrying", attempts: 1 });
    expect(l.targets).toHaveLength(2);
    expect(l.targets.every((t) => t !== undefined)).toBe(true);
    expect(w.opened().map((o) => o.source)).toEqual(["s1", "s2"]);
  });

  it("a source ace-media ended goes back to the daemon with the reason", () => {
    const w = world();
    const l = listener();
    w.sources.open("tab-pictures", { kind: "tab-pictures" }, l.events);
    w.sources.message({
      type: "source.status",
      source: "s1",
      status: "ended",
      reason: "encoder-unavailable",
    });
    expect(l.targets.at(-1)).toBeUndefined();
    expect(l.ended).toEqual(["encoder-unavailable"]);
  });

  it("a JPEG source's encodes are kept and sent again after a restart, and its pictures carry their text", () => {
    const w = world();
    const l = listener();
    const source = w.sources.open("tab-pictures", { kind: "tab-pictures" }, l.events);
    const encodes = [
      { id: 1, codec: "avc1.42E01F", width: 640, height: 400, fps: 30, bitrate: 2_000_000 },
    ];
    source.encodes(encodes);
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
  });
});

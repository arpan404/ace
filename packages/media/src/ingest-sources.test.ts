import { expect, it } from "vitest";
import { EgressRouter, type EgressUnit } from "./egress.ts";
import { encodeEgress, type MediaFrame } from "./frame.ts";
import {
  IngestSources,
  maxIngestReopens,
  type IngestAddress,
  type IngestProducer,
} from "./ingest-sources.ts";
import { RouteWatch } from "./route-watch.ts";
import type { RouteCapabilities } from "./routes.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

const capabilities: RouteCapabilities = {
  ingest: ["screen"],
  recordings: false,
  stills: false,
  delivery: false,
};

function unit(): MediaFrame {
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
    codec: 1,
    encode: 0,
    epoch: 1,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array([0, 0, 0, 1, 0x65]),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** ace-media as the sources see it, with what they sent, and one screen producer. */
function world() {
  const state = {
    settings: {
      encode: "auto",
      delivery: "legacy",
      recordings: "legacy",
      stills: "legacy",
    } as MediaSettings,
    health: "healthy" as MediaHealth,
    socket: "/run/m1i.sock" as string | undefined,
    needs: 0,
  };
  const sent: { message: ToMedia; payload: Uint8Array }[] = [];
  const points: (IngestAddress | undefined)[] = [];
  const delivered: EgressUnit[] = [];
  let answer: (() => void) | undefined;
  const watch: RouteWatch = new RouteWatch({
    settings: () => state.settings,
    health: () => state.health,
    capabilities: () => capabilities,
    onChange: (_, changed) => sources.routesChanged(changed),
  });
  const router = new EgressRouter((kind) => watch.routes()[kind]);
  let next = 0;
  const sources: IngestSources = new IngestSources({
    port: {
      send: (message, payload = new Uint8Array(0)) => {
        if (!state.socket) return false;
        sent.push({ message, payload: payload.slice() });
        return true;
      },
      ingest: () => (state.socket ? { socket: state.socket } : undefined),
      need: () => {
        state.needs++;
        return () => void state.needs--;
      },
    },
    router,
    routes: () => watch.routes(),
    settings: () => state.settings,
    capabilities: () => capabilities,
    randomBytes: (length) => new Uint8Array(length).fill(++next),
  });
  const producer: IngestProducer = {
    source: "screen:a",
    kind: "screen",
    origin: { kind: "screen", platform: "macos" },
    epoch: () => 3,
    consumers: {
      deliver: (u) => void delivered.push(u),
      record: () => {},
      still: () => {},
    },
    point: (address) => {
      points.push(address && { ...address, token: address.token.slice() });
      // A switch back to the daemon finishes when the test says so.
      return address ? Promise.resolve() : new Promise<void>((resolve) => (answer = resolve));
    },
    keyframe: () => {},
  };
  const opened = () =>
    sent.flatMap(({ message, payload }) =>
      message.type === "source.open" ? [{ handle: message.handle, token: payload }] : [],
    );
  const egress = (handle: number, sequence: number) =>
    router.push(encodeEgress(handle, sequence, unit()));
  return {
    state,
    sent,
    points,
    delivered,
    watch,
    sources,
    producer,
    opened,
    egress,
    settle,
    finishSwitch: () => answer?.(),
  };
}

it("a producer is pointed at ingest only once ace-media reports its source starting, with that source's fresh token", async () => {
  const w = world();
  w.sources.add(w.producer);
  expect(w.opened()).toHaveLength(1);
  expect(w.sent.map((s) => s.message.type)).toEqual(["source.open", "source.egress"]);
  expect(w.points).toEqual([]);
  w.sources.message({ type: "source.status", source: "screen:a", status: "starting" });
  await w.settle();
  expect(w.points).toEqual([{ socket: "/run/m1i.sock", token: w.opened()[0]?.token, epoch: 3 }]);
  expect(w.opened()[0]?.token).toHaveLength(32);
  expect(w.state.needs).toBe(1);
});

it("moving the route back points the producer at the daemon, and its units still on egress reach the consumers until it has switched", async () => {
  const w = world();
  w.sources.add(w.producer);
  w.sources.message({ type: "source.status", source: "screen:a", status: "starting" });
  const handle = w.opened()[0]?.handle ?? 0;
  w.egress(handle, 0);
  w.state.settings = { ...w.state.settings, encode: "legacy" };
  w.watch.update();
  expect(w.points.at(-1)).toBeUndefined();
  // Sent to ace-media before the producer switched: still delivered.
  w.egress(handle, 1);
  expect(w.delivered.map((u) => u.sequence)).toEqual([0, 1]);
  w.finishSwitch();
  await w.settle();
  expect(w.sent.at(-1)?.message).toEqual({ type: "source.close", source: "screen:a" });
  w.egress(handle, 2);
  expect(w.delivered).toHaveLength(2);
  // The setting is legacy: nothing keeps ace-media running for this source.
  expect(w.state.needs).toBe(0);
});

it("ace-media exiting points the producer back at the daemon, and the next start opens its source with a new handle and token", async () => {
  const w = world();
  w.sources.add(w.producer);
  w.sources.message({ type: "source.status", source: "screen:a", status: "starting" });
  w.state.health = "restarting";
  w.state.socket = undefined;
  w.sources.exited();
  w.watch.update();
  expect(w.points.at(-1)).toBeUndefined();
  // ace-media is still wanted while it restarts.
  expect(w.state.needs).toBe(1);
  w.state.health = "healthy";
  w.state.socket = "/run/m2i.sock";
  w.watch.update();
  w.sources.replay();
  const [first, second] = w.opened();
  expect(w.opened()).toHaveLength(2);
  expect(second?.handle).not.toBe(first?.handle);
  expect(second?.token).not.toEqual(first?.token);
  w.sources.message({ type: "source.status", source: "screen:a", status: "starting" });
  await w.settle();
  expect(w.points.at(-1)).toMatchObject({ socket: "/run/m2i.sock", token: second?.token });
});

it("a producer whose ingest connection keeps ending is reopened a bounded number of times, then stays on the daemon until its route changes", async () => {
  const w = world();
  const source = w.sources.add(w.producer);
  for (let attempt = 0; attempt <= maxIngestReopens; attempt++) {
    w.sources.message({ type: "source.status", source: "screen:a", status: "starting" });
    await w.settle();
    source.reconnect();
  }
  expect(w.opened()).toHaveLength(maxIngestReopens + 1);
  expect(w.points.at(-1)).toBeUndefined();
  w.state.settings = { ...w.state.settings, encode: "legacy" };
  w.watch.update();
  w.state.settings = { ...w.state.settings, encode: "auto" };
  w.watch.update();
  expect(w.opened()).toHaveLength(maxIngestReopens + 2);
});

it("closing a source closes it in ace-media and stops keeping ace-media running for it", () => {
  const w = world();
  const source = w.sources.add(w.producer);
  source.close();
  expect(w.sent.at(-1)?.message).toEqual({ type: "source.close", source: "screen:a" });
  expect(w.state.needs).toBe(0);
});

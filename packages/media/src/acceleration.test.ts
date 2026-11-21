import { expect, it } from "vitest";
import {
  MediaAccelerationStore,
  type AccelerationChange,
  type MediaCapabilityEntry,
  type SourceAcceleration,
} from "./acceleration.ts";
import { EgressRouter } from "./egress.ts";
import { IngestSources, type IngestProducer } from "./ingest-sources.ts";
import { mediaRoutes, type RouteCapabilities } from "./routes.ts";
import type { MediaSettings } from "./supervision-policy.ts";
import type { FromMedia } from "./wire.ts";

const built: RouteCapabilities = {
  ingest: ["tab-pictures"],
  delivery: false,
};
const settings: MediaSettings = {
  encode: "auto",
  delivery: "auto",
  recordings: "auto",
  stills: "auto",
};

const routes = () => mediaRoutes(settings, "healthy", built);

/** The store fed by the daemon's sources, with ace-media faked at its control lane. */
function world() {
  const store = new MediaAccelerationStore();
  const changes: AccelerationChange[] = [];
  store.watch((change) => changes.push(change));
  let ids = 0;
  const timers: (() => void)[] = [];
  const sources = new IngestSources({
    port: {
      send: () => true,
      ingest: () => ({ socket: "/tmp/i.sock", websocketPort: 4000 }),
      need: () => () => {},
      speaks: () => true,
    },
    router: new EgressRouter((kind) => routes()[kind]),
    routes,
    settings: () => settings,
    capabilities: () => built,
    randomBytes: (length) => new Uint8Array(length),
    id: () => `m${++ids}`,
    schedule: (run) => {
      timers.push(run);
      return () => {};
    },
    acceleration: (subject, value) => store.report(subject, value),
  });
  const producer: IngestProducer = {
    source: "capture-1",
    tabId: "tab-7",
    kind: "tab-pictures",
    origin: { kind: "tab-pictures" } as IngestProducer["origin"],
    epoch: () => 0,
    consumers: { deliver: () => {} },
    point: () => Promise.resolve(),
    keyframe: () => {},
  };
  const status = (source: string, acceleration?: SourceAcceleration) =>
    sources.message({
      type: "source.status",
      source,
      status: "starting",
      ...(acceleration ? { acceleration } : {}),
    });
  const drained = () => {
    for (const run of timers.splice(0)) run();
  };
  return { store, changes, sources, producer, status, drained };
}

const onTheProcessor: SourceAcceleration = {
  steps: [
    { step: "jpeg-decode", backend: "cpu", hardware: false, readbacks: 0, uploads: 0 },
    { step: "encode", backend: "chrome", hardware: false, readbacks: 0, uploads: 0 },
  ],
  degraded: true,
  reason: "Video runs on the processor here: this computer has no hardware video encoder.",
};
const onHardware: SourceAcceleration = {
  steps: [
    { step: "jpeg-decode", backend: "vt", hardware: true, readbacks: 0, uploads: 0 },
    { step: "encode", backend: "vt", hardware: true, readbacks: 0, uploads: 0 },
  ],
  degraded: false,
};

it("a source's steps are kept under the daemon's name and follow it across a reopen", () => {
  const { store, sources, producer, status, drained } = world();
  const source = sources.add(producer);
  status("m1", onTheProcessor);
  expect(store.of("capture-1")).toEqual(onTheProcessor);
  expect(store.for("tabId", "tab-7")).toEqual(onTheProcessor);
  expect(store.for("sessionId", "tab-7")).toBeUndefined();

  source.reconnect();
  status("m2", onHardware);
  expect(store.of("capture-1")).toEqual(onHardware);
  // The old path finishing (its drain running out) doesn't take the new path's report.
  drained();
  expect(store.of("capture-1")).toEqual(onHardware);
});

it("a source's report goes once nothing in ace-media runs it, and with ace-media", () => {
  const { store, sources, producer, status } = world();
  const source = sources.add(producer);
  status("m1", onHardware);
  source.close();
  expect(store.of("capture-1")).toBeUndefined();

  sources.add({ ...producer, source: "capture-2", tabId: "tab-8" });
  status("m2", onTheProcessor);
  expect(store.of("capture-2")).toEqual(onTheProcessor);
  sources.exited();
  store.exited();
  expect(store.sources()).toEqual([]);
  expect(store.for("tabId", "tab-8")).toBeUndefined();
});

it("listeners hear a change only when the report changes", () => {
  const { changes, sources, producer, status } = world();
  sources.add(producer);
  status("m1", onHardware);
  status("m1", structuredClone(onHardware));
  status("m1");
  status("m1", onTheProcessor);
  expect(changes.map((c) => (c.kind === "source" ? c.subject.tabId : c.kind))).toEqual([
    "tab-7",
    "tab-7",
  ]);
});

it("the capability list comes from ready, is replaced whole by each change, and goes on exit", () => {
  const { store, changes } = world();
  const vt: MediaCapabilityEntry = {
    step: "encode",
    codec: "avc1.640028",
    backend: "vt",
    hardware: true,
    zeroCopy: true,
    state: "timed-out",
    maxWidth: 0,
    maxHeight: 0,
  };
  const ready: FromMedia = {
    type: "ready",
    protocol: 1,
    version: "1",
    pid: 1,
    capabilities: [vt],
    ingest: { socket: "/tmp/i.sock", websocketPort: 4000 },
    control: { socket: "/tmp/c.sock" },
    listen: { loopbackPort: 0 },
  };
  store.message(ready);
  expect(store.capabilities()).toEqual([vt]);
  const late = { ...vt, state: "ok" as const, maxWidth: 4096, maxHeight: 2304 };
  store.message({ type: "capabilities.changed", capabilities: [late] });
  expect(store.capabilities()).toEqual([late]);
  store.exited();
  expect(store.capabilities()).toBeUndefined();
  expect(changes.filter((c) => c.kind === "capabilities")).toHaveLength(3);
});

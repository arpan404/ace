import { expect, it } from "vitest";
import { EgressRouter, type EgressUnit, type LegacyConsumers } from "./egress.ts";
import { encodeEgress, type MediaFrame } from "./frame.ts";
import { sourceRoute, sourceKinds, type SourceRoute } from "./routes.ts";

function frame(mark: number, encode = 0): MediaFrame {
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
    encode,
    epoch: 1,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array([mark]),
  };
}

function consumers() {
  const got = {
    deliver: [] as EgressUnit[],
    record: [] as EgressUnit[],
    still: [] as EgressUnit[],
  };
  const sinks: LegacyConsumers = {
    deliver: (unit) => void got.deliver.push(unit),
    record: (unit) => void got.record.push(unit),
    still: (unit) => void got.still.push(unit),
  };
  return { got, sinks };
}

const marks = (units: EgressUnit[]) => units.map((unit) => unit.frame.payload[0]);

/** encode auto, everything else legacy, with ace-media ingesting every kind. */
const allLegacy: SourceRoute = sourceRoute(
  "tab",
  { encode: "auto", delivery: "legacy", recordings: "legacy", stills: "legacy" },
  "healthy",
  { ingest: sourceKinds, recordings: true, stills: true, delivery: true },
);
/** encode and delivery auto: only the recorder and still maker stay in the daemon. */
const deliveredByMedia: SourceRoute = sourceRoute(
  "tab",
  { encode: "auto", delivery: "auto", recordings: "legacy", stills: "legacy" },
  "healthy",
  { ingest: sourceKinds, recordings: true, stills: true, delivery: true },
);

/** A router whose route table the test changes, as `RouteWatch` would. */
function routed(initial: SourceRoute) {
  const table = { route: initial };
  return { table, router: new EgressRouter(() => table.route) };
}

it("two interleaved sources with the same encode id each reach only their own consumers", () => {
  const { router } = routed(allLegacy);
  const a = consumers(),
    b = consumers();
  const ha = router.open("a", "tab", a.sinks);
  const hb = router.open("b", "tab", b.sinks);
  expect(ha).not.toBe(hb);
  router.push(encodeEgress(ha, 0, frame(1, 7)));
  router.push(encodeEgress(hb, 0, frame(2, 7)));
  router.push(encodeEgress(ha, 1, frame(3, 7)));
  router.push(encodeEgress(hb, 1, frame(4, 7)));
  for (const kind of ["deliver", "record", "still"] as const) {
    expect(marks(a.got[kind])).toEqual([1, 3]);
    expect(marks(b.got[kind])).toEqual([2, 4]);
  }
  expect(a.got.deliver.every((unit) => unit.source === "a")).toBe(true);
});

it("frames reach only the consumers the current route keeps in the daemon", () => {
  const { table, router } = routed(deliveredByMedia);
  const { got, sinks } = consumers();
  const handle = router.open("s", "tab", sinks);
  router.push(encodeEgress(handle, 0, frame(1)));
  expect([got.deliver.length, got.record.length, got.still.length]).toEqual([0, 1, 1]);

  table.route = allLegacy;
  router.push(encodeEgress(handle, 1, frame(2)));
  expect(marks(got.deliver)).toEqual([2]);
});

it("each source follows the route of its own kind", () => {
  const routes = { tab: allLegacy, screen: deliveredByMedia } as const;
  const router = new EgressRouter((kind) => (kind === "screen" ? routes.screen : routes.tab));
  const tab = consumers(),
    screen = consumers();
  const ht = router.open("t", "tab", tab.sinks);
  const hs = router.open("s", "screen", screen.sinks);
  router.push(encodeEgress(ht, 0, frame(1)));
  router.push(encodeEgress(hs, 0, frame(2)));
  expect(marks(tab.got.deliver)).toEqual([1]);
  expect(marks(screen.got.deliver)).toEqual([]);
  expect(marks(screen.got.record)).toEqual([2]);
});

it("frames with an unknown or closed handle are dropped and counted", () => {
  const { router } = routed(allLegacy);
  const { got, sinks } = consumers();
  const closed = router.open("old", "tab", sinks);
  router.close(closed);
  // A new source never gets the closed source's handle back.
  const open = router.open("new", "tab", sinks);
  expect(open).not.toBe(closed);
  router.push(encodeEgress(closed, 0, frame(1)));
  router.push(encodeEgress(9_999, 0, frame(2)));
  router.push(new Uint8Array([1, 2, 3]));
  expect(got.deliver).toEqual([]);
  expect(router.drops()).toMatchObject({ closed: 1, unknown: 1, invalid: 1 });
});

it("a gap in a source's sequence is counted and marked on the next unit", () => {
  const { router } = routed(allLegacy);
  const { got, sinks } = consumers();
  const handle = router.open("s", "tab", sinks);
  for (const sequence of [0, 1, 4, 5]) router.push(encodeEgress(handle, sequence, frame(sequence)));
  expect(got.record.map((unit) => unit.gap)).toEqual([false, false, true, false]);
  expect(router.drops().gaps).toBe(2);
});

it("once the route moves the producer back to the daemon, egress still in flight is dropped, never delivered twice", () => {
  const settings = {
    encode: "auto",
    delivery: "legacy",
    recordings: "legacy",
    stills: "legacy",
  } as const;
  const capabilities = { ingest: sourceKinds, recordings: true, stills: true, delivery: true };
  const { table, router } = routed(sourceRoute("tab", settings, "healthy", capabilities));
  const { got, sinks } = consumers();
  const handle = router.open("s", "tab", sinks);
  router.push(encodeEgress(handle, 0, frame(1)));
  // Health drops without an exit: the table changes, and nobody tells the router.
  table.route = sourceRoute("tab", settings, "restarting", capabilities);
  router.push(encodeEgress(handle, 1, frame(2)));
  router.push(encodeEgress(handle, 2, frame(3)));
  expect(marks(got.deliver)).toEqual([1]);
  expect(router.drops().unrouted).toBe(2);
});

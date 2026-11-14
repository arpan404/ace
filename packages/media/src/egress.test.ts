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

it("two interleaved sources with the same encode id each reach only their own consumers", () => {
  const router = new EgressRouter();
  const a = consumers(),
    b = consumers();
  const ha = router.open("a", a.sinks, allLegacy);
  const hb = router.open("b", b.sinks, allLegacy);
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

it("frames reach only the consumers the route keeps in the daemon", () => {
  const router = new EgressRouter();
  const { got, sinks } = consumers();
  const handle = router.open("s", sinks, deliveredByMedia);
  router.push(encodeEgress(handle, 0, frame(1)));
  expect([got.deliver.length, got.record.length, got.still.length]).toEqual([0, 1, 1]);

  router.reroute(handle, allLegacy);
  router.push(encodeEgress(handle, 1, frame(2)));
  expect(marks(got.deliver)).toEqual([2]);
});

it("frames with an unknown or closed handle are dropped and counted", () => {
  const router = new EgressRouter();
  const { got, sinks } = consumers();
  const closed = router.open("old", sinks, allLegacy);
  router.close(closed);
  // A new source never gets the closed source's handle back.
  const open = router.open("new", sinks, allLegacy);
  expect(open).not.toBe(closed);
  router.push(encodeEgress(closed, 0, frame(1)));
  router.push(encodeEgress(9_999, 0, frame(2)));
  router.push(new Uint8Array([1, 2, 3]));
  expect(got.deliver).toEqual([]);
  expect(router.drops()).toMatchObject({ closed: 1, unknown: 1, invalid: 1 });
});

it("a gap in a source's sequence is counted and marked on the next unit", () => {
  const router = new EgressRouter();
  const { got, sinks } = consumers();
  const handle = router.open("s", sinks, allLegacy);
  for (const sequence of [0, 1, 4, 5]) router.push(encodeEgress(handle, sequence, frame(sequence)));
  expect(got.record.map((unit) => unit.gap)).toEqual([false, false, true, false]);
  expect(router.drops().gaps).toBe(2);
});

it("frames still in flight for a source whose route no longer has egress are dropped", () => {
  const router = new EgressRouter();
  const { got, sinks } = consumers();
  const handle = router.open("s", sinks, allLegacy);
  router.reroute(handle, { ...allLegacy, producer: "daemon", egress: false });
  router.push(encodeEgress(handle, 0, frame(1)));
  expect(got.deliver).toEqual([]);
  expect(router.drops().unrouted).toBe(1);
});

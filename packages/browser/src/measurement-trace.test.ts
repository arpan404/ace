import { expect, it } from "vitest";
import { MeasurementTrace } from "./measurement-trace.ts";
const marker = {
  name: "TimeStamp",
  ts: 1_000_000,
  pid: 1,
  tid: 1,
  args: { data: { message: "start", frame: "target" } },
};
it("reports the largest layout shift session and excludes recent input and other tabs", () => {
  const trace = new MeasurementTrace("start");
  trace.accept({
    value: [
      marker,
      {
        name: "LayoutShift",
        ts: 1_100_000,
        pid: 1,
        args: { data: { score: 0.1, had_recent_input: false } },
      },
      {
        name: "LayoutShift",
        ts: 1_500_000,
        pid: 1,
        args: { data: { score: 0.2, had_recent_input: false } },
      },
      {
        name: "LayoutShift",
        ts: 2_600_000,
        pid: 1,
        args: { data: { score: 0.25, had_recent_input: false } },
      },
      {
        name: "LayoutShift",
        ts: 2_800_000,
        pid: 1,
        args: { data: { score: 0.9, had_recent_input: true } },
      },
      {
        name: "LayoutShift",
        ts: 1_200_000,
        pid: 2,
        args: { data: { score: 1, had_recent_input: false } },
      },
    ],
  });
  expect(trace.result(3000).layoutShift).toBeCloseTo(0.3);
});
it("limits a continuous layout shift session to five seconds", () => {
  const trace = new MeasurementTrace("start");
  trace.accept({
    value: [
      marker,
      ...Array.from({ length: 12 }, (_, index) => ({
        name: "LayoutShift",
        pid: 1,
        ts: 1_000_000 + index * 500_000,
        args: { data: { score: 0.1, had_recent_input: false } },
      })),
    ],
  });
  expect(trace.result(6000).layoutShift).toBeCloseTo(1);
});
it("uses only target compositor frames and reports lost evidence", () => {
  const trace = new MeasurementTrace("start");
  trace.accept({
    value: [
      marker,
      {
        name: "SetLayerTreeId",
        ts: 1_000_001,
        pid: 1,
        args: { data: { frame: "target", layerTreeId: 1 } },
      },
      ...Array.from({ length: 2401 }, (_, index) => ({
        name: "DrawFrame",
        pid: 1,
        args: { layerTreeId: 1 },
        ts: 1_000_000 + index * 1000,
      })),
      { name: "DrawFrame", pid: 2, ts: 1_005_000 },
    ],
  });
  const result = trace.result(3000);
  expect(result.updatesMs).toHaveLength(2400);
  expect(result.truncated).toBe(true);
  expect(result.inferredRefresh).toBe(true);
});

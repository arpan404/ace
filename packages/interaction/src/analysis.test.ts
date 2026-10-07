import { expect, it } from "vitest";
import { analyzeInteraction, aggregateMeasurements, validateMeasurementBudget } from "./index.ts";
import type { InteractionEvidence } from "@ace/protocol";
const target = { kind: "window", bundleId: "dev.ace.test", windowId: 1 } as const;
function evidence(updatesMs: number[], refreshHz = 60): InteractionEvidence {
  return {
    source: "screen-frames",
    target,
    refreshHz,
    windowMs: 2000,
    updatesMs,
    notes: [],
    actionAtMs: 0,
  };
}
function animation(hz: number, stall = 0) {
  const times: number[] = [];
  for (let frame = 1; frame <= hz; frame++)
    times.push((frame * 1000) / hz + (frame > hz / 2 ? stall : 0));
  return times;
}
it("idle tails do not lower FPS or create dropped frames at 60 and 120 Hz", () => {
  for (const hz of [60, 120]) {
    const result = analyzeInteraction(evidence(animation(hz), hz));
    expect(result.verdict).toBe("smooth");
    expect(result.effectiveFps).toBeCloseTo(hz);
    expect(result.droppedFrames).toBe(0);
    expect(result.hitches).toEqual([]);
    expect(result.settleMs).toBe(1000);
    expect(result.latencyMs).toBeCloseTo(1000 / hz);
  }
});
it("an injected 120 ms stall is a hitch and changes the verdict", () => {
  const result = analyzeInteraction(evidence(animation(60, 120)));
  expect(result.verdict).toBe("janky");
  expect(result.hitches).toHaveLength(1);
  expect(result.hitches[0]?.atMs).toBeCloseTo(500);
  expect(result.hitches[0]?.durationMs).toBeCloseTo(136.6667, 2);
  expect(result.droppedFrames).toBe(7);
  expect(result.hitchRatioMsPerS).toBeGreaterThan(100);
});
it("latency ignores pre-input animation and uses the action region when provided", () => {
  const result = analyzeInteraction({
    ...evidence([0, 16, 32, 300, 320]),
    actionAtMs: 100,
    latencyMs: 220,
  });
  expect(result.latencyMs).toBe(220);
  expect(result.frames).toBe(2);
  expect(result.settleMs).toBe(220);
  expect(result.verdict).toBe("inconclusive");
});
it("settle is omitted when the last change has less than 250 ms of stillness", () => {
  const result = analyzeInteraction({ ...evidence(animation(60)), windowMs: 1100 });
  expect(result.settleMs).toBeUndefined();
  expect(result.notes.join(" ")).toContain("250 ms");
});
it("long pauses separate animation spans instead of counting intentional stillness as dropped frames", () => {
  const result = analyzeInteraction(
    evidence([
      ...animation(60).slice(0, 30),
      ...animation(60)
        .slice(30)
        .map((t) => t + 400),
    ]),
  );
  expect(result.droppedFrames).toBe(0);
  expect(result.effectiveFps).toBeCloseTo(60);
  expect(result.notes.join(" ")).toContain("intentional pauses");
});
it("high load, capture overhead and incomplete evidence lower confidence", () => {
  const healthy = evidence(animation(60));
  expect(analyzeInteraction(healthy).confidence).toBe("high");
  expect(analyzeInteraction({ ...healthy, hostLoad: 9, cores: 8 }).confidence).toBe("low");
  expect(analyzeInteraction({ ...healthy, captureOverheadPct: 11 }).confidence).toBe("low");
  expect(analyzeInteraction({ ...healthy, truncated: true }).verdict).toBe("inconclusive");
  expect(analyzeInteraction(evidence([])).verdict).toBe("no_change");
  expect(analyzeInteraction(evidence([100])).confidence).toBe("low");
});
it("bounded hitch output still counts every missed interval in the ratio", () => {
  const result = analyzeInteraction({
    ...evidence(Array.from({ length: 100 }, (_, i) => i * 30)),
    windowMs: 3000,
  });
  expect(result.hitches).toHaveLength(20);
  expect(result.droppedFrames).toBe(99);
  expect(result.hitchRatioMsPerS).toBeCloseTo(444.4444, 2);
});
it("repeats report median and directional worst values and retain worst run details", () => {
  const runs = [
    analyzeInteraction(evidence(animation(60))),
    analyzeInteraction(evidence(animation(60, 120))),
  ];
  const result = aggregateMeasurements(runs);
  expect(result.verdict).toBe("janky");
  expect(result.hitches).toHaveLength(1);
  expect(result.repeat?.runs.map((run) => run.verdict)).toEqual(["smooth", "janky"]);
  expect(result.repeat?.metrics.droppedFrames).toEqual({ median: 3.5, worst: 7 });
  expect(result.repeat?.metrics.effectiveFps?.worst).toBe(runs[1]?.effectiveFps);
});
it("repeats omit absent timing metrics instead of substituting zero", () => {
  const result = aggregateMeasurements([
    analyzeInteraction(evidence([])),
    analyzeInteraction(evidence([180])),
  ]);
  expect(result.repeat?.metrics.latencyMs).toEqual({ median: 180, worst: 180 });
});
it("excess observation, repeats and drag time are rejected before capture", () => {
  for (const options of [
    { observeMs: 10001, repeat: 1 },
    { observeMs: 2000, repeat: 6 },
    { observeMs: 10000, repeat: 3 },
    { observeMs: 9900, repeat: 1, action: { kind: "pointer.drag", durationMs: 200 } },
  ])
    expect(() => validateMeasurementBudget(options)).toThrow();
  expect(() => validateMeasurementBudget({ observeMs: 4000, repeat: 5 })).not.toThrow();
});

it("a traced long stall after delayed input is measured on the input clock", () => {
  const result = analyzeInteraction({
    ...evidence([600, 950, 970, 990, 1010, 1030, 1050, 1070]),
    actionAtMs: 500,
    longTasks: [{ atMs: 610, durationMs: 300 }],
  });
  expect(result.hitches[0]).toEqual({ atMs: 100, durationMs: 350 });
  expect(result.longTasks).toEqual([{ atMs: 110, durationMs: 300 }]);
  expect(result.verdict).toBe("janky");
});

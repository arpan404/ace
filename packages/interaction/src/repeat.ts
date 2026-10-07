import { InteractionMeasurement } from "@ace/protocol";
const severity = { smooth: 0, no_change: 1, minor_hitches: 2, inconclusive: 3, janky: 4 };
const keys = [
  "refreshHz",
  "windowMs",
  "frames",
  "latencyMs",
  "settleMs",
  "effectiveFps",
  "droppedFrames",
  "hitchRatioMsPerS",
  "layoutShift",
  "hostLoad",
  "captureOverheadPct",
] as const;
function summary(values: number[], lowerIsWorse: boolean) {
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  if (upper === undefined) throw new Error("Empty metric");
  const lower = ordered[middle - 1] ?? upper;
  return {
    median: ordered.length % 2 ? upper : (lower + upper) / 2,
    worst: lowerIsWorse ? ordered[0] : ordered.at(-1),
  };
}
/** Keep the worst run's filmstrip and detailed gaps together; summaries cover measured values
 * only, never treating a missing latency/settle/animation metric as zero. */
export function aggregateMeasurements(
  raw: readonly InteractionMeasurement[],
): InteractionMeasurement {
  if (raw.length < 1 || raw.length > 5) throw new Error("Expected one to five measurement runs");
  const runs = raw.map((run) => InteractionMeasurement.parse(run));
  const worst = runs.toSorted(
    (a, b) =>
      severity[b.verdict] - severity[a.verdict] ||
      (b.hitchRatioMsPerS ?? 0) - (a.hitchRatioMsPerS ?? 0),
  )[0];
  if (!worst) throw new Error("Missing run");
  if (runs.length === 1) return worst;
  const metrics: Record<string, unknown> = {};
  for (const key of keys) {
    const values = runs.flatMap((run) => (run[key] === undefined ? [] : [run[key]]));
    if (values.length)
      metrics[key] = summary(values, key === "effectiveFps" || key === "refreshHz");
  }
  metrics["hitchMs"] = summary(
    runs.map(
      (run) =>
        run.hitchTimeMs ??
        run.hitches.reduce(
          (total, hitch) => total + Math.max(0, hitch.durationMs - 1000 / run.refreshHz),
          0,
        ),
    ),
    false,
  );
  const taskRuns = runs.filter((run) => run.longTasks !== undefined);
  if (taskRuns.length)
    metrics["longTaskMs"] = summary(
      taskRuns.map((run) =>
        (run.longTasks ?? []).reduce((total, task) => total + task.durationMs, 0),
      ),
      false,
    );
  return InteractionMeasurement.parse({
    ...worst,
    repeat: { runs: runs.map(({ verdict, confidence }) => ({ verdict, confidence })), metrics },
    notes: [
      ...worst.notes,
      "Details and filmstrip show the worst run; repeat summaries use available values only.",
    ].slice(0, 32),
  });
}

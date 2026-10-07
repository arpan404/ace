import { InteractionEvidence, InteractionMeasurement } from "@ace/protocol";

/** Gaps >=250ms separate observed animation spans: pixels alone cannot distinguish a pause
 * from a long stall. Idle tails are never counted as dropped frames. */
export function analyzeInteraction(raw: InteractionEvidence): InteractionMeasurement {
  const evidence = InteractionEvidence.parse(raw);
  const { updatesMs, actionAtMs, cores, truncated, refreshAssumed, ...base } = evidence;
  const origin = actionAtMs ?? 0;
  const updates = [
    ...new Set(updatesMs.filter((time) => time >= origin && time <= evidence.windowMs)),
  ].toSorted((a, b) => a - b);
  const interval = 1000 / evidence.refreshHz;
  const hitches: InteractionMeasurement["hitches"] = [];
  let animatingMs = 0,
    intervals = 0,
    droppedFrames = 0,
    hitchMs = 0,
    pauses = 0;
  for (let index = 1; index < updates.length; index++) {
    const previous = updates[index - 1],
      current = updates[index];
    if (previous === undefined || current === undefined) continue;
    const gap = current - previous;
    if (
      gap >= 250 &&
      !(evidence.longTasks ?? []).some(
        (task) => task.atMs < current && task.atMs + task.durationMs > previous,
      )
    ) {
      pauses++;
      continue;
    }
    animatingMs += gap;
    intervals++;
    if (gap > interval * 1.5) {
      const excess = gap - interval;
      hitchMs += excess;
      droppedFrames += Math.max(1, Math.round(gap / interval) - 1);
      hitches.push({ atMs: previous - origin, durationMs: gap });
    }
  }
  const ratio = animatingMs > 0 ? hitchMs / (animatingMs / 1000) : undefined;
  const first = updates[0],
    last = updates.at(-1);
  const settled = last !== undefined && evidence.windowMs - last >= 250;
  const notes = [...evidence.notes];
  let confidence: InteractionMeasurement["confidence"] =
    updates.length >= 20 ? "high" : updates.length >= 6 ? "medium" : "low";
  if (confidence === "low")
    notes.push("Too few content updates to assess continuous animation reliably.");
  if (evidence.hostLoad !== undefined && cores !== undefined && evidence.hostLoad > cores) {
    confidence = "low";
    notes.push("Host one-minute load exceeds logical cores; host contention may cause hitches.");
  }
  if ((evidence.captureOverheadPct ?? 0) > 10) {
    confidence = "low";
    notes.push("Capture overhead exceeds 10% of the measured span.");
  }
  if (refreshAssumed) {
    confidence = "low";
    notes.push("Refresh rate was assumed; FPS and hitch estimates may not match the display.");
  }
  if (truncated) {
    confidence = "low";
    notes.push("Capture evidence was incomplete or reached its bound.");
  }
  if (pauses) {
    confidence = "low";
    notes.push(
      "Gaps of at least 250 ms separate animation spans; long stalls and intentional pauses are indistinguishable.",
    );
  }
  if (last !== undefined && !settled)
    notes.push("Content did not remain still for 250 ms before the window ended.");
  const verdict: InteractionMeasurement["verdict"] = truncated
    ? "inconclusive"
    : updates.length === 0
      ? "no_change"
      : intervals < 5 || (pauses > 0 && (ratio ?? 0) < 5)
        ? "inconclusive"
        : ratio !== undefined && ratio > 10
          ? "janky"
          : ratio !== undefined && ratio >= 5
            ? "minor_hitches"
            : "smooth";
  return InteractionMeasurement.parse({
    ...base,
    ...(evidence.longTasks
      ? {
          longTasks: evidence.longTasks
            .filter((task) => task.atMs + task.durationMs > origin)
            .map((task) => ({
              atMs: Math.max(0, task.atMs - origin),
              durationMs: task.durationMs - Math.max(0, origin - task.atMs),
            })),
        }
      : {}),
    frames: updates.length,
    hitchTimeMs: hitchMs,
    verdict,
    confidence,
    hitches: hitches
      .toSorted((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20)
      .toSorted((a, b) => a.atMs - b.atMs),
    ...(actionAtMs !== undefined && first !== undefined
      ? { latencyMs: evidence.latencyMs ?? first - origin }
      : {}),
    ...(settled && actionAtMs !== undefined ? { settleMs: last - origin } : {}),
    ...(animatingMs > 0
      ? { effectiveFps: (intervals * 1000) / animatingMs, droppedFrames, hitchRatioMsPerS: ratio }
      : {}),
    notes: notes.slice(0, 32),
  });
}

/** Bounds include long drag injection, not only time after input. */
export function validateMeasurementBudget(options: {
  observeMs: number;
  repeat: number;
  action?: { kind: string; durationMs?: number | undefined } | undefined;
}): void {
  const duration = options.action?.kind === "pointer.drag" ? (options.action.durationMs ?? 0) : 0;
  if (
    options.observeMs < 1 ||
    options.observeMs > 10_000 ||
    !Number.isInteger(options.observeMs) ||
    !Number.isInteger(options.repeat) ||
    options.repeat < 1 ||
    options.repeat > 5 ||
    options.observeMs + duration > 10_000 ||
    (options.observeMs + duration) * options.repeat > 20_000
  )
    throw new Error("Measurement exceeds 10 seconds per run or 20 seconds total");
}

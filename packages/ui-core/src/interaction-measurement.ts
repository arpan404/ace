import type { InteractionMeasurement } from "@ace/protocol";
import { appName } from "./app-names.ts";

export { readMeasurement, type MeasurementResult } from "./measurement-read.ts";

/*
 * An interaction measurement as the transcript words it: the verdict, what was done where,
 * the headline numbers (median · worst over repeats), how sure the tool is, and a timeline of
 * the recorded window. Times are relative to the input (or to capture start when the agent
 * only watched), as the tool reports them. Pure.
 */

type Verdict = InteractionMeasurement["verdict"];
/** A status tone of the app's one vocabulary (`data-tone`). */
export type MeasurementTone = "done" | "needs-you" | "failed" | "idle";

const verdicts: Record<Verdict, { label: string; tone: MeasurementTone }> = {
  smooth: { label: "Smooth", tone: "done" },
  minor_hitches: { label: "Minor hitches", tone: "needs-you" },
  janky: { label: "Janky", tone: "failed" },
  no_change: { label: "No visible change", tone: "idle" },
  inconclusive: { label: "Inconclusive", tone: "idle" },
};

export function verdictText(verdict: Verdict): { label: string; tone: MeasurementTone } {
  return verdicts[verdict];
}

/** "4.2", "42", "2,000": one decimal below ten, whole numbers above. */
function amount(value: number): string {
  if (value < 10) return String(Math.round(value * 10) / 10);
  return Math.round(value).toLocaleString("en-US");
}

const ms = (value: number) => `${amount(value)} ms`;

/** "Safari" for a window, "the browser tab" for a tab. */
function targetText(target: InteractionMeasurement["target"]): string {
  return target.kind === "window" ? appName(target.bundleId) : "the browser tab";
}

const characters = (text: string) => `${text.length} character${text.length === 1 ? "" : "s"}`;

/** What the agent did before watching: "Scrolled", "Pressed command+K", "Typed 12 characters". */
function actionText(action: NonNullable<InteractionMeasurement["action"]>): string {
  if ("action" in action)
    switch (action.action) {
      case "click":
        return "Clicked";
      case "type":
        return `Typed ${characters(action.text)}`;
      case "press":
        return `Pressed ${action.key}`;
      case "scroll":
        return "Scrolled";
      case "drag":
        return "Dragged";
    }
  switch (action.kind) {
    case "pointer.click":
      return action.button === "right" ? "Right-clicked" : "Clicked";
    case "pointer.drag":
      return "Dragged";
    case "key.press":
      return `Pressed ${[...action.modifiers, action.key].join("+")}`;
    case "text.type":
      return `Typed ${characters(action.text)}`;
    case "text.paste":
      return "Pasted text";
    case "scroll":
      return "Scrolled";
    default:
      return "Used the pointer";
  }
}

/** "Scrolled in Safari", "Watched the browser tab". */
export function measuredText(measurement: InteractionMeasurement): string {
  const target = targetText(measurement.target);
  return measurement.action
    ? `${actionText(measurement.action)} in ${target}`
    : `Watched ${target}`;
}

type MetricKey = "latencyMs" | "settleMs" | "effectiveFps" | "hitchRatioMsPerS";
const metrics: { key: MetricKey; label: string; unit: string }[] = [
  { key: "latencyMs", label: "Response", unit: "ms" },
  { key: "settleMs", label: "Settled", unit: "ms" },
  { key: "effectiveFps", label: "Active", unit: "fps" },
  { key: "hitchRatioMsPerS", label: "Hitching", unit: "ms/s" },
];

export interface MeasurementMetric {
  label: string;
  /** "42 ms", or "42 · 61 ms" (median · worst) over repeats. */
  value: string;
}

/** One headline number; over repeats its median and worst run. */
function metricValue(measurement: InteractionMeasurement, key: MetricKey): string | undefined {
  const spec = metrics.find((entry) => entry.key === key);
  if (!spec) return undefined;
  const summary = measurement.repeat?.metrics[key];
  const single = measurement[key];
  const value = summary
    ? `${amount(summary.median)} · ${amount(summary.worst)} ${spec.unit}`
    : single === undefined
      ? undefined
      : `${amount(single)} ${spec.unit}`;
  if (value === undefined || key !== "effectiveFps") return value;
  const refresh = measurement.repeat?.metrics.refreshHz.median ?? measurement.refreshHz;
  return `${value} of ${amount(refresh)} Hz`;
}

/** Response, settle, active frame rate and hitching, those the tool could measure. */
export function measurementMetrics(measurement: InteractionMeasurement): MeasurementMetric[] {
  return metrics.flatMap(({ key, label }) => {
    const value = metricValue(measurement, key);
    return value === undefined ? [] : [{ label, value }];
  });
}

/** The one number a collapsed row shows next to its verdict: hitching, else the response. */
function keyNumber(measurement: InteractionMeasurement): string | undefined {
  const value = metricValue(measurement, "hitchRatioMsPerS");
  if (value !== undefined) return `${value} hitching`;
  const latency = metricValue(measurement, "latencyMs");
  return latency === undefined ? undefined : `${latency} response`;
}

/**
 * A collapsed row's outcome: "Smooth · 0.8 ms/s hitching". Over repeats the verdict is the
 * worst run's, so it says how many runs it was ("Minor hitches in 1 of 3 runs").
 */
export function outcomeText(measurement: InteractionMeasurement): string {
  const { label } = verdicts[measurement.verdict];
  const runs = measurement.repeat?.runs ?? [];
  const alike = runs.filter((run) => run.verdict === measurement.verdict).length;
  const verdict =
    runs.length > 1 && alike < runs.length ? `${label} in ${alike} of ${runs.length} runs` : label;
  return [verdict, keyNumber(measurement)].filter(Boolean).join(" · ");
}

/** The analyzer's notes behind a lowered confidence, in a few words, most telling first. */
const reasons: [RegExp, string][] = [
  [/load exceeds logical cores/i, "host was busy"],
  [/capture overhead/i, "capture overhead was high"],
  [/refresh rate was assumed/i, "refresh rate was assumed"],
  [/incomplete|reached its bound/i, "recording was cut short"],
  [/too few content updates/i, "too few frames"],
  [/gaps of at least 250 ms/i, "long pauses in the motion"],
];

/** "Low confidence: host was busy"; nothing when the tool is confident. */
export function confidenceText(measurement: InteractionMeasurement): string | undefined {
  if (measurement.confidence === "high") return undefined;
  const level = measurement.confidence === "low" ? "Low confidence" : "Medium confidence";
  const reason = reasons.find(([pattern]) =>
    measurement.notes.some((note) => pattern.test(note)),
  )?.[1];
  return reason ? `${level}: ${reason}` : level;
}

export interface MeasurementRun {
  tone: MeasurementTone;
  /** "Run 2: minor hitches, low confidence". */
  label: string;
}

/** Each repeat's verdict, in order; none for a single run. */
export function measurementRuns(measurement: InteractionMeasurement): MeasurementRun[] {
  const runs = measurement.repeat?.runs ?? [];
  if (runs.length < 2) return [];
  return runs.map((run, index) => ({
    tone: verdicts[run.verdict].tone,
    label: `Run ${index + 1}: ${verdicts[run.verdict].label.toLowerCase()}${
      run.confidence === "low" ? ", low confidence" : ""
    }`,
  }));
}

export interface MeasurementTimeline {
  /** Positions are percent of the recorded window. */
  span?: { from: number; to: number } | undefined;
  hitches: { at: number; width: number; text: string }[];
  settle?: number | undefined;
  /** The axis: "Input" (or "Start" when the agent only watched) and the window's length. */
  ticks: { start: string; end: string };
  /** The whole strip in words, for assistive tech. */
  text: string;
  /** The tool listed only its twenty longest hitches; the ratio still counts every one. */
  unlisted: boolean;
}

/**
 * The recorded window as a strip: when the content first changed and when it settled (or that
 * it was still moving), and each hitch at its time, sized by its length.
 */
export function measurementTimeline(measurement: InteractionMeasurement): MeasurementTimeline {
  const { hitches, settleMs, latencyMs } = measurement;
  const last = hitches.at(-1);
  const end = Math.max(measurement.windowMs, settleMs ?? 0, last ? last.atMs + last.durationMs : 0);
  const at = (time: number) => (end > 0 ? Math.min(100, Math.max(0, (time / end) * 100)) : 0);
  const moved = measurement.frames > 0;
  const frame = 1000 / measurement.refreshHz;
  const listed = hitches.reduce((sum, hitch) => sum + Math.max(0, hitch.durationMs - frame), 0);
  const count = `${hitches.length} hitch${hitches.length === 1 ? "" : "es"}`;
  const text = [
    measurement.action ? "Input at 0 ms" : "Recording from 0 ms",
    moved && latencyMs !== undefined ? `first change at ${ms(latencyMs)}` : undefined,
    moved ? count : "no visible change",
    settleMs !== undefined
      ? `settled at ${ms(settleMs)}`
      : moved
        ? "still changing when recording ended"
        : undefined,
    `${ms(measurement.windowMs)} recorded`,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    span: moved ? { from: at(latencyMs ?? 0), to: at(settleMs ?? end) } : undefined,
    hitches: hitches.map((hitch) => ({
      at: at(hitch.atMs),
      width: at(hitch.durationMs),
      text: `Hitch at ${ms(hitch.atMs)}, ${ms(hitch.durationMs)} long`,
    })),
    settle: settleMs === undefined ? undefined : at(settleMs),
    ticks: { start: measurement.action ? "Input" : "Start", end: ms(end) },
    text,
    unlisted: (measurement.hitchTimeMs ?? 0) > listed + 1,
  };
}

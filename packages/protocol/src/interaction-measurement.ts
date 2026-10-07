import { z } from "zod";
import { Attachment } from "./context.ts";
import { ScreenInput } from "./screen-v2.ts";
import { ScreenBundle } from "./screen-base.ts";
import { BrowserInteractionAction } from "./browser-interaction.ts";
export { BrowserInteractionAction } from "./browser-interaction.ts";
const ms = z.number().finite().nonnegative();
const options = {
  observeMs: z.number().int().min(1).max(10_000).default(2000),
  repeat: z.number().int().min(1).max(5).default(1),
  filmstrip: z.boolean().default(true),
};
const [, click, drag, key, type, scroll, paste] = ScreenInput.options;
/** Complete actions cannot leave a held pointer across a measurement window. */
export const ScreenMeasurementAction = z.discriminatedUnion("kind", [
  click,
  drag,
  key,
  type,
  scroll,
  paste,
]);
export const ScreenMeasurementOptions = z.strictObject({
  ...options,
  action: ScreenMeasurementAction.optional(),
});
export type ScreenMeasurementOptions = z.infer<typeof ScreenMeasurementOptions>;
export const BrowserMeasurementOptions = z.strictObject({
  ...options,
  interaction: BrowserInteractionAction.optional(),
});
export type BrowserMeasurementOptions = z.infer<typeof BrowserMeasurementOptions>;
export const InteractionTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("window"),
    bundleId: ScreenBundle,
    windowId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("browser-tab"),
    threadId: z.string().min(1).max(256),
    tabId: z.string().min(1).max(256).optional(),
  }),
]);
export const InteractionFilmstrip = z.object({
  type: z.literal("image"),
  mimeType: z.literal("image/jpeg"),
  data: z.string().max(1024 * 1024),
});
export const InteractionVerdict = z.enum([
  "smooth",
  "minor_hitches",
  "janky",
  "no_change",
  "inconclusive",
]);
export const InteractionConfidence = z.enum(["high", "medium", "low"]);
export const InteractionGap = z.object({ atMs: ms, durationMs: ms });
export const InteractionMetricSummary = z.object({ median: ms, worst: ms });
export const InteractionRepeat = z.object({
  runs: z
    .array(z.object({ verdict: InteractionVerdict, confidence: InteractionConfidence }))
    .min(1)
    .max(5),
  metrics: z.object({
    refreshHz: InteractionMetricSummary,
    windowMs: InteractionMetricSummary,
    frames: InteractionMetricSummary,
    latencyMs: InteractionMetricSummary.optional(),
    settleMs: InteractionMetricSummary.optional(),
    effectiveFps: InteractionMetricSummary.optional(),
    droppedFrames: InteractionMetricSummary.optional(),
    hitchRatioMsPerS: InteractionMetricSummary.optional(),
    layoutShift: InteractionMetricSummary.optional(),
    hostLoad: InteractionMetricSummary.optional(),
    captureOverheadPct: InteractionMetricSummary.optional(),
    longTaskMs: InteractionMetricSummary.optional(),
    hitchMs: InteractionMetricSummary,
  }),
});
export const InteractionMeasurement = z.object({
  // Add device sources here when device measurement is implemented.
  source: z.enum(["screen-frames", "browser-trace"]),
  target: InteractionTarget,
  action: z.union([ScreenInput, BrowserInteractionAction]).optional(),
  refreshHz: z.number().finite().positive().max(240),
  windowMs: ms.max(10_000),
  latencyMs: ms.optional(),
  settleMs: ms.optional(),
  frames: z.number().int().nonnegative().max(2400),
  effectiveFps: ms.optional(),
  droppedFrames: z.number().int().nonnegative().optional(),
  hitches: z.array(InteractionGap).max(20),
  hitchRatioMsPerS: ms.optional(),
  hitchTimeMs: ms.optional(),
  longTasks: z.array(InteractionGap).max(100).optional(),
  layoutShift: ms.optional(),
  verdict: InteractionVerdict,
  confidence: InteractionConfidence,
  hostLoad: ms.optional(),
  captureOverheadPct: ms.optional(),
  filmstrip: InteractionFilmstrip.optional(),
  notes: z.array(z.string().max(512)).max(32),
  repeat: InteractionRepeat.optional(),
});
export type InteractionMeasurement = z.infer<typeof InteractionMeasurement>;
export type InteractionTarget = z.infer<typeof InteractionTarget>;
export type InteractionFilmstrip = z.infer<typeof InteractionFilmstrip>;
/** Bounded evidence from native capture or CDP. Times use one monotonic clock relative to capture start. */
export const InteractionEvidence = InteractionMeasurement.pick({
  source: true,
  target: true,
  action: true,
  refreshHz: true,
  windowMs: true,
  latencyMs: true,
  longTasks: true,
  layoutShift: true,
  hostLoad: true,
  captureOverheadPct: true,
  filmstrip: true,
}).extend({
  updatesMs: z.array(ms.max(10_000)).max(2400),
  actionAtMs: ms.max(10_000).optional(),
  cores: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
  refreshAssumed: z.boolean().optional(),
  notes: z.array(z.string().max(512)).max(24).default([]),
});
export type InteractionEvidence = z.infer<typeof InteractionEvidence>;

/** Daemon-owned transcript evidence; image bytes use authenticated thread attachments. */
export const StepMeasurement = InteractionMeasurement.omit({ filmstrip: true }).extend({
  filmstrip: Attachment.optional(),
});
export type StepMeasurement = z.infer<typeof StepMeasurement>;

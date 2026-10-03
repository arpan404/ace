import { z } from "zod";
import { ContextMeter } from "@ace/protocol";
export const ContextSample = z.object({
  meter: ContextMeter,
  session: z.string().nullable(),
  compaction: z.string().nullable(),
});
export type ContextSample = z.infer<typeof ContextSample>;
export type ContextChange =
  | { type: "invalidate" }
  | { type: "compaction"; id: string }
  | {
      type: "sample";
      used?: number | undefined;
      window?: number | undefined;
      model?: string | undefined;
      session?: string | undefined;
      catalog?: number | undefined;
    };
/** Constant-size occupancy transitions, independent of storage and provider I/O. */
export function foldContext(
  prior: ContextSample,
  change: ContextChange,
): ContextSample | undefined {
  const sample = { ...prior, meter: { ...prior.meter } };
  if (change.type === "invalidate") {
    sample.meter.epoch++;
    sample.meter.usedTokens = null;
    sample.session = null;
  } else if (change.type === "compaction") {
    if (sample.compaction === change.id) return undefined;
    sample.compaction = change.id;
    sample.meter.epoch++;
    sample.meter.usedTokens = null;
  } else {
    if (
      (change.model && sample.meter.model !== change.model) ||
      (change.session && sample.session !== change.session)
    ) {
      sample.meter.epoch++;
      sample.meter.usedTokens = null;
      sample.meter.windowTokens = null;
      sample.meter.source = "unknown";
    }
    if (change.model) sample.meter.model = change.model;
    if (change.session) sample.session = change.session;
    if (change.used !== undefined) sample.meter.usedTokens = change.used;
    const window =
      change.window ??
      (sample.meter.source === "provider"
        ? (sample.meter.windowTokens ?? change.catalog)
        : change.catalog);
    if (window !== undefined) {
      sample.meter.windowTokens = window;
      sample.meter.source =
        change.window !== undefined || sample.meter.source === "provider" ? "provider" : "catalog";
    }
  }
  return sample;
}

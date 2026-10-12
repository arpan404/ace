import { requireNativeModule } from "expo";
import { z } from "zod";
const native = requireNativeModule<{
  watchInput(tag: number): Promise<void>;
  stopInputMetrics(): Promise<void>;
  fontEvidence(): Promise<unknown>;
  commitInput(length: number): Promise<void>;
  inputMetrics(): Promise<unknown>;
  probeInput(count: number): Promise<unknown>;
}>("AceNative");
const Metrics = z.object({
  droppedMetricReports: z.number().int().nonnegative(),
  missingMutations: z.number().int().nonnegative(),
  missingCommits: z.number().int().nonnegative(),
  missingDraws: z.number().int().nonnegative(),
  missingFrameMetrics: z.number().int().nonnegative(),
  invalidFrameMetrics: z.number().int().nonnegative(),
  pendingAttempts: z.number().int().min(0).max(1),
  misses: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  minimumCoverage: z.literal(0.95),
  allAttemptP95ConservativeMs: z.number().nonnegative(),
  samples: z.number().int().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
  keys: z.number().int().nonnegative(),
  mutations: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
});
export const commitInput = native.commitInput;
export const watchInput = native.watchInput;
export const stopInputMetrics = native.stopInputMetrics;
export async function inputMetrics() {
  return Metrics.parse(await native.inputMetrics());
}
export async function probeInput() {
  return Metrics.parse(await native.probeInput(120));
}

const FontEvidence = z.object({
  assetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  actualAdvance: z.number(),
  bundledAdvance: z.number(),
  foreground: z.string(),
  textSizePx: z.number(),
});
export async function fontEvidence() {
  return FontEvidence.parse(await native.fontEvidence());
}

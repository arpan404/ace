import { requireNativeModule } from "expo";
import { z } from "zod";
import { readExecutionMode } from "./native-mode.ts";
const native = requireNativeModule<{
  watchInput(tag: number): Promise<void>;
  stopInputMetrics(): Promise<void>;
  fontEvidence(): Promise<unknown>;
  commitInput(length: number): Promise<void>;
  inputMetrics(): Promise<unknown>;
  probeInput(count: number): Promise<unknown>;
}>("AceNative");

/** Input hooks exist only in fixture builds; production has no such native methods. */
function instrumented() {
  const mode = readExecutionMode();
  if (mode === "production") throw new Error("Input measurement is unavailable in this build.");
  return native;
}
export function watchInput(tag: number): Promise<void> {
  return instrumented().watchInput(tag);
}
export function commitInput(length: number): Promise<void> {
  return instrumented().commitInput(length);
}
export function stopInputMetrics(): Promise<void> {
  return instrumented().stopInputMetrics();
}
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
export async function inputMetrics() {
  return Metrics.parse(await instrumented().inputMetrics());
}
export async function probeInput() {
  return Metrics.parse(await instrumented().probeInput(120));
}

const FontEvidence = z.object({
  assetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  actualAdvance: z.number(),
  bundledAdvance: z.number(),
  foreground: z.string(),
  textSizePx: z.number(),
});
export async function fontEvidence() {
  return FontEvidence.parse(await instrumented().fontEvidence());
}

import { requireNativeModule } from "expo";
import { z } from "zod";
const native = requireNativeModule<{
  watchInput(tag: number): Promise<void>;
  stopInputMetrics(): Promise<void>;
  fontEvidence(): Promise<unknown>;
  commitInput(length: number): Promise<void>;
  inputMetrics(): Promise<unknown>;
}>("AceNative");
const Metrics = z.object({
  samples: z.number().int().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});
export const commitInput = native.commitInput;
export const watchInput = native.watchInput;
export const stopInputMetrics = native.stopInputMetrics;
export async function inputMetrics() {
  return Metrics.parse(await native.inputMetrics());
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

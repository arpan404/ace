import { requireNativeModule } from "expo";
import { z } from "zod";
const native = requireNativeModule<{
  watchInput(tag: number): Promise<void>;
  stopInputMetrics(): Promise<void>;
  inputMetrics(): Promise<unknown>;
}>("AceNative");
const Metrics = z.object({
  samples: z.number().int().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});
export const watchInput = native.watchInput;
export const stopInputMetrics = native.stopInputMetrics;
export async function inputMetrics() {
  return Metrics.parse(await native.inputMetrics());
}

import { z } from "zod";
import type { PiExtensionApi } from "./extension-api.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Usage = z.object({ tokens: count, contextWindow: count.positive() });
export const PiContextSample = Usage.extend({
  type: z.literal("ace_context_usage"),
  model: z.string().min(1).max(1024).optional(),
});

/** Pi owns occupancy estimates, including trailing messages and compaction. */
export function registerPiContextSamples(pi: PiExtensionApi): void {
  for (const event of ["session_start", "turn_end", "model_select", "session_compact"] as const)
    pi.on(event, (_event, ctx) => {
      const usage = Usage.safeParse(ctx.getContextUsage());
      if (!usage.success) return;
      const sample = PiContextSample.safeParse({
        type: "ace_context_usage",
        ...usage.data,
        ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
      });
      if (sample.success) ctx.ui.notify(JSON.stringify(sample.data), "info");
    });
}

export function piContextSample(message: unknown): z.infer<typeof PiContextSample> | undefined {
  if (typeof message !== "string" || message.length > 4096) return;
  try {
    const result = PiContextSample.safeParse(JSON.parse(message));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}

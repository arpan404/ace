import { z } from "zod";
export const ClaudeSelectionOptions = z.strictObject({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  serviceTier: z.enum(["fast", "default"]).nullable().optional(),
});

export function claudeSelectionFlags(options: z.infer<typeof ClaudeSelectionOptions>) {
  return {
    effortLevel: options.effort ?? null,
    fastMode: options.serviceTier === "fast",
  };
}

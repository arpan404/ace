import { z } from "zod";
export const ClaudeSelectionOptions = z.strictObject({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
});

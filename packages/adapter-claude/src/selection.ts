import { z } from "zod";
export const ClaudeSelectionOptions = z.strictObject({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk", "auto"]).optional(),
});

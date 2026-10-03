import { z } from "zod";
/** Only documented thread settings, never arbitrary provider config or credentials. */
export const CodexSelectionOptions = z.strictObject({
  effort: z.string().max(64).nullable().optional(),
  summary: z.enum(["auto", "concise", "detailed", "none"]).nullable().optional(),
  serviceTier: z.string().max(64).nullable().optional(),
});

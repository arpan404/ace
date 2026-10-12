import { z } from "zod";
export const CompactionInput = z.object({
  database: z.string().min(1),
  availableBytes: z.number().nonnegative(),
});
export const CompactionOutput = z.enum(["complete", "deferred"]);

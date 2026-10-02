import { z } from "zod";
import { Completion } from "./schema.ts";

export const PreparedWorkspace = z.object({ cwd: z.string().min(1).max(4096) });
export const MergeResponse = z.object({
  revision: Completion.shape.revision,
  conflict: z.string().min(1).max(16_384).nullable(),
  trivial: z.boolean(),
});
export const PullRequestResponse = z.object({ revision: Completion.shape.revision });
export const VerificationResponse = z.object({
  passed: z.boolean(),
  summary: z.string().min(1).max(16_384),
});

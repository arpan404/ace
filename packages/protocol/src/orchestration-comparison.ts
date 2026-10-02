import { z } from "zod";
import { LaneId, OrchestrationArtifact, OrchestrationUsage } from "./orchestration.ts";
export const LaneComparison = z.object({
  laneId: LaneId,
  durationMs: z.number().nonnegative(),
  usage: OrchestrationUsage,
  artifact: OrchestrationArtifact,
  checksPassed: z.boolean(),
  files: z
    .array(
      z.object({
        path: z.string().max(4096),
        oldPath: z.string().max(4096).optional(),
        status: z.enum(["A", "M", "D", "R", "C", "T"]),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        binary: z.boolean(),
      }),
    )
    .max(4096),
  filesTruncated: z.boolean(),
  patch: z.string().max(65536),
  patchTruncated: z.boolean(),
});
export type LaneComparison = z.infer<typeof LaneComparison>;

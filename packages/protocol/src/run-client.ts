import { z } from "zod";
import { RunId } from "./ids.ts";
export const RunCheckpoints = z.object({
  before: z.string().min(1).max(128).optional(),
  after: z.string().min(1).max(128).optional(),
  state: z.enum(["pending", "ready", "unavailable"]),
  error: z.string().max(128).optional(),
});
export type RunCheckpoints = z.infer<typeof RunCheckpoints>;
export const RunClientUpdated = z.object({
  type: z.literal("run.client.updated"),
  runId: RunId,
  checkpoints: RunCheckpoints,
});
export type RunClientUpdated = z.infer<typeof RunClientUpdated>;

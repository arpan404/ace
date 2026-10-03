import { z } from "zod";
import { WorkspaceId } from "./ids.ts";
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
/** Display ownership, independent of agent tree authority and execution selection. */
export const DeckOwnership = z.object({
  deckId: key,
  runId: key,
  workspaceId: WorkspaceId,
  role: z.enum(["root", "planner", "worker", "reviewer", "integrator", "delegate"]),
  laneId: key.optional(),
});
export type DeckOwnership = z.infer<typeof DeckOwnership>;

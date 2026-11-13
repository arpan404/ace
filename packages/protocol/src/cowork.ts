import { z } from "zod";

/*
 * The person and agents share ace's computer use (ADR 0143). In `cowork` both act at once and an
 * agent's action waits while the person is using the same surface (a browser tab, a screen app,
 * a simulator). `exclusive` is the person's explicit Take control (or a Spade take-over): agents
 * are refused there as before. Absent fields read as `cowork`, no pointer and not active.
 */

/** Whether a surface is shared (`cowork`) or held by the person alone (`exclusive`). */
export const CoworkSharing = z.enum(["cowork", "exclusive"]);
export type CoworkSharing = z.infer<typeof CoworkSharing>;

/** What the agent did last at its pointer, so a client can draw its cursor. */
export const AgentPointerKind = z.enum(["move", "click", "drag", "scroll", "type"]);
export type AgentPointerKind = z.infer<typeof AgentPointerKind>;

/**
 * The agent's latest action point on a surface, in that surface's own stream coordinates: CSS
 * viewport pixels for a browser tab, the session's picture pixels for a screen session, device
 * points for a simulator. `at` is when it acted, ms since the epoch.
 */
export const AgentPointer = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  kind: AgentPointerKind,
  at: z.number().int().nonnegative(),
});
export type AgentPointer = z.infer<typeof AgentPointer>;

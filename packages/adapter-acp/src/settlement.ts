import { z } from "zod";
import { object } from "./data.ts";
const stopReason = z.enum(["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"]);
/** Both translation and I/O require a concrete terminal reason. */
export function promptStop(result: unknown): string | undefined {
  const parsed = stopReason.safeParse(object(result)["stopReason"]);
  return parsed.success ? parsed.data : undefined;
}
export const cancellationGraceMs = 12_000;
export function cancellationDeadline(now: number): number {
  return now + cancellationGraceMs;
}
/** Cursor cancellation gives no shell termination proof; Antigravity also exposes surviving shells. */
export function shellSurvivesPrompt(provider: string, reason: string): boolean {
  return reason === "cancelled" || provider === "antigravity";
}

import { z } from "zod";
import type { InteractionRequest, InteractionResolution, ToolStatus } from "@ace/protocol";
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
/**
 * Whether a shell tool may outlive the prompt that ended with `reason`. The translator and the
 * session's settlement both decide by this, so the UI and the input gate never disagree.
 *
 * Only a shell that started (reported in_progress, or was allowed) can survive: one still pending
 * or awaiting approval never ran. A prompt that failed (no stop reason) takes its tools with it.
 * Cursor cancellation gives no shell termination proof; Antigravity also exposes surviving shells.
 */
export function shellSurvivesPrompt(provider: string, reason: string, status: ToolStatus): boolean {
  if (status !== "running" || !stopReason.safeParse(reason).success) return false;
  return reason === "cancelled" || provider === "antigravity";
}
/** Whether an answer to a tool's request refuses the tool: a deny option, a rejected plan, or a cancelled request. */
export function answerRefusesTool(
  request: InteractionRequest,
  resolution: InteractionResolution | undefined,
  cancelled: boolean,
): boolean {
  if (cancelled) return true;
  if (resolution?.kind === "plan_review") return resolution.decision === "reject";
  if (resolution?.kind !== "approval" || request.kind !== "approval") return false;
  return request.options.some(
    (o) => o.id === resolution.optionId && ["deny", "deny_always"].includes(o.kind),
  );
}
/**
 * Whether an answer picked a neutral native choice (kind `other`, such as "Ask later"): it
 * neither starts nor refuses the tool, so the agent's own later updates settle the call.
 */
export function answerIsNeutral(
  request: InteractionRequest,
  resolution: InteractionResolution | undefined,
): boolean {
  if (resolution?.kind !== "approval" || request.kind !== "approval") return false;
  return request.options.some((o) => o.id === resolution.optionId && o.kind === "other");
}

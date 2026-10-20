import { ProviderGoal } from "@ace/protocol";
import { number, object, string, type Data } from "./native.ts";

/**
 * Claude's `active_goal` frame (its `/goal` Stop hook): the goal it keeps checking, or null once
 * met or cleared. Undefined when the frame carries nothing ace can show.
 */
export function claudeGoal(data: Data): ProviderGoal | null | undefined {
  if (data["value"] === null) return null;
  const value = object(data["value"]);
  const setAt = Math.trunc(number(value["set_at"]));
  const reason = string(value["last_reason"]).trim();
  const goal = ProviderGoal.safeParse({
    objective: string(value["condition"]).trim(),
    status: "active",
    checks: Math.trunc(number(value["iterations"])),
    ...(setAt > 0 ? { setAt } : {}),
    ...(reason ? { lastReason: reason } : {}),
  });
  return goal.success ? goal.data : undefined;
}

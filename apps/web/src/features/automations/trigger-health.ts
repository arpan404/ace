import type { AutomationRun } from "@ace/protocol";
import { compileSchedule } from "@ace/automations/recurrence";
import type { AutomationSchedule } from "@ace/protocol";

/*
 * Health copy without inventing status. Sidebar attention comes from this
 * automation's own lastRun (never the global 50-run inbox); triggerError is a
 * stored diagnostic with a safe retry, lastPollError stays as it was.
 * Running still means the whole tree is unsettled.
 */

export interface TriggerHealth {
  triggerError: { message: string; at: number } | undefined;
  lastPollError: { message: string; at: number } | undefined;
  lastRun: AutomationRun | undefined;
  enabled: boolean;
}

export function sidebarNeedsAttention(health: TriggerHealth): boolean {
  if (health.triggerError) return true;
  if (health.lastPollError) return true;
  return health.lastRun?.status === "failed";
}

/** A trigger that failed to initialize can be retried once its definition is fixed. */
export function canRetryTrigger(health: Pick<TriggerHealth, "triggerError">): boolean {
  return health.triggerError !== undefined;
}

function fixHint(message: string): string {
  if (/auth|login|credential|401|403/i.test(message))
    return "Sign in to GitHub on this machine, then check that you can access the repository.";
  if (/404|not found|repository/i.test(message))
    return "Check the repository in Edit and your GitHub access on this machine.";
  if (/rate.?limit|429/i.test(message))
    return "GitHub is limiting requests. ace will try again at the next check.";
  return "Check your connection and GitHub access on this machine. ace will try again at the next check.";
}

/** Stored trigger diagnostics become a fix in words, without CLI output or codes. */
export function triggerErrorCopy(triggerError: { message: string; at: number }): string {
  return fixHint(triggerError.message);
}

export type ScheduleState = "next" | "exhausted" | "not-placed" | "not-schedule";

/**
 * Why a schedule shows no next run. An uncompilable expression is invalid (the form
 * blocks it); a compilable one with no future occurrence is exhausted (COUNT/UNTIL
 * spent); otherwise the service simply hasn't placed it yet.
 */
export function scheduleState(
  schedule: AutomationSchedule,
  nextRunAt: number | undefined,
  after: number,
): ScheduleState {
  if (nextRunAt !== undefined) return "next";
  let exhausted = false;
  try {
    exhausted = compileSchedule(schedule).next(after) === undefined;
  } catch {
    return "not-placed";
  }
  return exhausted ? "exhausted" : "not-placed";
}

export function scheduleStateCopy(state: ScheduleState): string {
  switch (state) {
    case "exhausted":
      return "This schedule is finished. Edit it to run again.";
    case "not-placed":
      return "Not scheduled yet";
    case "next":
      return "";
    case "not-schedule":
      return "";
  }
}

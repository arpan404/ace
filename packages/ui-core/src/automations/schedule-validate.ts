import { compileSchedule } from "@ace/automations/recurrence";
import type { AutomationSchedule } from "@ace/protocol";

/*
 * Custom RRULE/cron validation by the daemon's own recurrence rules, so
 * FREQ=BOGUS fails in the form instead of reading back as "No upcoming run".
 * Pure: no clock, no I/O. Callers pass the schedule the form describes.
 */

export function customScheduleError(schedule: AutomationSchedule): string | undefined {
  try {
    compileSchedule(schedule);
    return undefined;
  } catch {
    if (schedule.kind === "cron") return "Enter a valid cron schedule, like 30 7 * * 1-5.";
    return "Enter a valid RRULE, like FREQ=WEEKLY;BYDAY=MO.";
  }
}

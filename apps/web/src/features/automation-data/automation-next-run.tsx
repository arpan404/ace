import type { Automation } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { formatNextRun, localTimeZone } from "@/features/automation-schedule/index.ts";
import { scheduleState, scheduleStateCopy } from "./trigger-health.ts";

/**
 * When it runs next. With automations off on the daemon's machine nothing runs, so it says so
 * and links to the setting; a spent schedule says it is finished, while one the daemon
 * hasn't placed yet says that, not a guess.
 */
export function NextRun(props: {
  automation: Automation;
  nextRunAt: number | undefined;
  now: number;
  running: boolean | undefined;
}) {
  const { automation, nextRunAt } = props;
  if (!automation.enabled) return "Paused. Resume to schedule the next run.";
  if (props.running === false)
    return (
      <>
        Automations are off on this machine.{" "}
        <Link
          to="/settings/agents"
          hash="automations.enabled"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Turn on Run automations
        </Link>
      </>
    );
  if (nextRunAt !== undefined) {
    const zone =
      automation.trigger.kind === "schedule" ? automation.trigger.schedule.timezone : undefined;
    const when = formatNextRun(nextRunAt, props.now, zone);
    return zone && zone !== localTimeZone() ? `${when} (${zone})` : when;
  }
  switch (automation.trigger.kind) {
    case "github":
      return "On the next matching event";
    case "file":
      return "On the next change";
    case "manual":
      return "Only when you run it";
    case "schedule": {
      const state = scheduleState(automation.trigger.schedule, undefined, props.now);
      if (state === "exhausted") return scheduleStateCopy(state);
      return "Not scheduled yet";
    }
  }
}

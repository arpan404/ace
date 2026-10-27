import type { Automation } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { automationsOffText, localTimeZone, nextRunText } from "@ace/ui-core/automations";

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
        {automationsOffText}{" "}
        <Link
          to="/settings/agents"
          hash="automations.enabled"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Turn on Run automations
        </Link>
      </>
    );
  return nextRunText(automation, nextRunAt, props.now, localTimeZone());
}

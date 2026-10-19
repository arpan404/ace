import { goalResumable, goalTitle, goalUsage } from "@ace/ui-core";
import type { ProviderGoal } from "@ace/protocol";
import { CaretDownIcon, CaretUpIcon, TargetIcon } from "@phosphor-icons/react";
import { useId, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useGoalCommand } from "./goal-command.ts";

/**
 * The thread's native goal in the strip: "Pursuing goal · all tests pass · 120K tokens", the
 * chevron at the row's far right, opening to the whole objective, the provider's latest reason
 * it isn't met, and Pause, Resume or Clear where ace can change the goal.
 */
export function GoalStrip(props: {
  threadId: string;
  goal: ProviderGoal;
  /** ace can set, pause and clear this provider's goals (Codex); Claude's are its own `/goal`. */
  editable: boolean;
  indicators: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailsId = useId();
  const change = useGoalCommand(props.threadId);
  const { goal } = props;
  const usage = goalUsage(goal);
  const act = (next: Parameters<typeof change>[0]) => {
    setBusy(true);
    void change(next).finally(() => setBusy(false));
  };
  return (
    <section aria-label="Goal" className="text-xs">
      <div className="flex h-7 min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-muted-foreground focus-ring-inset hover:text-foreground"
        >
          {/* Never a spinner: an active goal can wait between turns while nothing runs. */}
          <Icon icon={TargetIcon} size={12} className="shrink-0" />
          <span className="shrink-0 text-foreground">{goalTitle(goal.status)}</span>
          {!open && <span className="min-w-0 truncate">{goal.objective}</span>}
          {!open && usage && (
            <span className="shrink-0 text-subtle-foreground tabular-nums">· {usage}</span>
          )}
          <Icon icon={open ? CaretUpIcon : CaretDownIcon} size={12} className="ml-auto shrink-0" />
        </button>
        {props.indicators}
      </div>
      <div id={detailsId} hidden={!open} className="space-y-1.5 px-1 pb-1">
        <p className="text-ui break-words whitespace-pre-wrap text-foreground">{goal.objective}</p>
        {goal.lastReason && <p className="text-muted-foreground">Not met yet: {goal.lastReason}</p>}
        {usage && <p className="text-subtle-foreground tabular-nums">{usage}</p>}
        {props.editable && (
          <div className="flex items-center gap-1">
            {goal.status === "active" && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => act({ status: "paused" })}
              >
                Pause
              </Button>
            )}
            {goalResumable(goal.status) && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => act({ status: "active" })}
              >
                Resume
              </Button>
            )}
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => act("clear")}>
              Clear goal
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

import { goalResumable, goalTitle, goalUsage } from "@ace/ui-core";
import type { ProviderGoal } from "@ace/protocol";
import { CaretDownIcon, CaretUpIcon, TargetIcon, XIcon } from "@phosphor-icons/react";
import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { PauseBarsIcon, ResumeIcon } from "@/components/ace-icons.tsx";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useGoalCommand } from "./goal-command.ts";

/**
 * The thread's native goal in the strip: "Pursuing goal · all tests pass · 120K tokens", then,
 * where ace can change the goal, Pause or Resume and Clear as icons. The chevron at the row's
 * far right shows only when there is more to read: an objective too long for the row, or the
 * provider's latest reason the goal isn't met.
 */
export function GoalStrip(props: {
  threadId: string;
  goal: ProviderGoal;
  /** ace can set, pause and clear this provider's goals (Codex); Claude's are its own `/goal`. */
  editable: boolean;
  /** The thread is working right now: an active goal's title sweeps, as a live step's does. */
  working: boolean;
  indicators: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailsId = useId();
  const change = useGoalCommand(props.threadId);
  const { goal } = props;
  const usage = goalUsage(goal);
  const sweeping = props.working && goal.status === "active";
  const act = (next: Parameters<typeof change>[0]) => {
    setBusy(true);
    void change(next).finally(() => setBusy(false));
  };
  const toggle = () => setOpen(!open);
  const [clipped, objective] = useClipped(goal.objective);
  const more = open || clipped || !!goal.lastReason;
  const summary = (
    <>
      {/* Never a spinner: an active goal can wait between turns while nothing runs. */}
      <Icon icon={TargetIcon} size={12} className="shrink-0" />
      {/* Only while work runs, never on an active goal waiting between turns; each time work
          starts the sweep remounts and plays its three passes again. */}
      <span
        key={sweeping ? "sweep" : "still"}
        className={cn("shrink-0", sweeping ? "step-shimmer" : "text-foreground")}
      >
        {goalTitle(goal.status)}
      </span>
      {!open && (
        <span ref={objective} className="min-w-0 truncate">
          {goal.objective}
        </span>
      )}
      {!open && usage && (
        <span className="shrink-0 text-subtle-foreground tabular-nums">· {usage}</span>
      )}
    </>
  );
  const row = "flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-muted-foreground";
  return (
    <section aria-label="Goal" className="text-xs">
      <div className="flex h-7 min-w-0 items-center gap-0.5">
        {more ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={toggle}
            className={`${row} focus-ring-inset hover:text-foreground`}
          >
            {summary}
          </button>
        ) : (
          <div className={row}>{summary}</div>
        )}
        {props.editable && goal.status === "active" && (
          <IconButton
            icon={PauseBarsIcon}
            label="Pause goal"
            size="sm"
            disabled={busy}
            onClick={() => act({ status: "paused" })}
          />
        )}
        {props.editable && goalResumable(goal.status) && (
          <IconButton
            icon={ResumeIcon}
            label="Resume goal"
            size="sm"
            disabled={busy}
            onClick={() => act({ status: "active" })}
          />
        )}
        {props.editable && (
          <IconButton
            icon={XIcon}
            label="Clear goal"
            size="sm"
            disabled={busy}
            onClick={() => act("clear")}
          />
        )}
        {/* The row's button opens it from the keyboard; the chevron is the same toggle for a pointer. */}
        {more && (
          <span
            aria-hidden
            onClick={toggle}
            className="grid size-6 shrink-0 cursor-pointer place-items-center text-muted-foreground hover:text-foreground"
          >
            <Icon icon={open ? CaretUpIcon : CaretDownIcon} size={12} />
          </span>
        )}
        {props.indicators}
      </div>
      <div id={detailsId} hidden={!open} className="space-y-1 px-1 pb-1">
        <p className="text-ui break-words whitespace-pre-wrap text-foreground">{goal.objective}</p>
        {goal.lastReason && <p className="text-muted-foreground">Not met yet: {goal.lastReason}</p>}
        {usage && <p className="text-subtle-foreground tabular-nums">{usage}</p>}
      </div>
    </section>
  );
}

/**
 * Whether a truncating element's text runs past its width, kept current as it resizes or its
 * text changes. Returns the ref to put on the element (a callback: the element comes and goes).
 */
function useClipped(text: string): [boolean, (element: HTMLElement | null) => void] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (!element || !text) return;
    const measure = () => setClipped(element.scrollWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, text]);
  return [clipped, setElement];
}

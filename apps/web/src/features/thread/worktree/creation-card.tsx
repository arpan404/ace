import type { WorktreeCreationProgress } from "@ace/protocol";
import {
  formatDuration,
  worktreeHeadline,
  worktreeNote,
  worktreeStepRows,
  worktreeSummary,
  type WorktreeStepRow,
} from "@ace/ui-core";
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  CheckCircleIcon,
  GitForkIcon,
  LaptopIcon,
  StopCircleIcon,
  WarningCircleIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { stripControl } from "../composer/composer-styles.ts";
import type { WorktreeAction, WorktreeCreationState } from "./use-worktree-creation.ts";

/*
 * A new thread's worktree as it is made, under the person's first message: a muted heading and
 * one quiet card with a line per step the daemon has reached, checkout's progress bar, a
 * "More details" disclosure over the redacted log, and Cancel / Don't use worktree (Retry once
 * it failed or was cancelled). Once made it folds to one line, "Worktree ready · branch · 4.2s",
 * which opens on the same steps with their timings and the log.
 */

/** The collapsed "Worked for" line's look, so settled lines in a transcript read alike. */
const foldedLine =
  "group -mx-1.5 inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-sm px-1.5 text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground";

const refusals: Record<NonNullable<WorktreeCreationState["refused"]>, string> = {
  busy: "Another action on this worktree is still running. Try again in a moment.",
  cleanup_required: "Cleanup hasn't finished, so this can't run yet.",
  settled: "It had already finished.",
  not_found: "The daemon no longer has this worktree request.",
  forbidden: "This device isn't allowed to change it.",
  offline: "Couldn't reach the daemon. Try again once connected.",
};

const actions: Record<
  WorktreeAction,
  { label: string; busy: string; tip: string; icon: PhosphorIcon }
> = {
  local: {
    label: "Don't use worktree",
    busy: "Switching…",
    tip: "Start the thread on the local checkout instead and send your message there",
    icon: LaptopIcon,
  },
  cancel: {
    label: "Cancel",
    busy: "Cancelling…",
    tip: "Stop and remove the half-made worktree. Your message stays unsent; Retry starts over",
    icon: XIcon,
  },
  retry: {
    label: "Retry",
    busy: "Retrying…",
    tip: "Try creating the worktree again",
    icon: ArrowClockwiseIcon,
  },
};
/** Left to right: the way out first, the step forward last. */
const actionOrder: readonly WorktreeAction[] = ["local", "cancel", "retry"];

/** The worktree being made, or how its making ended; nothing until the daemon has reported. */
export function WorktreeCreationCard(props: {
  state: WorktreeCreationState | undefined;
  onAction(action: WorktreeAction): void;
}) {
  const progress = props.state?.progress;
  if (!props.state || !progress) return null;
  if (progress.state === "done" || progress.state === "local")
    return <WorktreeReadyLine progress={progress} />;
  return <CreationCard state={props.state} progress={progress} onAction={props.onAction} />;
}

function CreationCard(props: {
  state: WorktreeCreationState;
  progress: WorktreeCreationProgress;
  onAction(action: WorktreeAction): void;
}) {
  const { progress, state } = props;
  const [open, setOpen] = useState(false);
  const panel = useId();
  const heading = useId();
  const running = progress.state === "running" || progress.state === "cancelling";
  const note = worktreeNote(progress);
  const offered = actionOrder.filter((action) => progress.actions.includes(action));
  return (
    <section aria-labelledby={heading} className="fx-view-in flex flex-col gap-2">
      <p
        id={heading}
        className="flex min-w-0 items-center gap-2 text-ui text-muted-foreground"
      >
        {progress.state === "failed" ? (
          <Icon icon={WarningCircleIcon} size={14} className="text-status-failed" />
        ) : (
          <Icon icon={GitForkIcon} size={14} className="text-subtle-foreground" />
        )}
        <span className={running ? "shimmer" : undefined}>{worktreeHeadline(progress)}</span>
      </p>
      <div className="group rounded-card py-1 pr-2 pl-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
        <StepList rows={worktreeStepRows(progress)} times={open} />
        {note && (
          <p role="alert" className="py-1 text-ui text-muted-foreground">
            {note}
          </p>
        )}
        {state.refused && (
          <p role="alert" className="py-1 text-xs text-status-failed">
            {refusals[state.refused]}
          </p>
        )}
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
            className={foldedLine}
          >
            <CaretRightIcon
              aria-hidden
              size={14}
              className={cn(
                "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
                open && "rotate-90",
              )}
            />
            More details
          </button>
          <span className="ml-auto flex shrink-0 items-center">
            {offered.map((action) => (
              <ActionButton
                key={action}
                action={action}
                sending={state.sending}
                onClick={() => props.onAction(action)}
              />
            ))}
          </span>
        </div>
        {open && <DetailsLog id={panel} lines={progress.details} />}
      </div>
    </section>
  );
}

/** A quiet labelled action; the label drops to its icon on a phone, the tooltip says what it does. */
function ActionButton(props: {
  action: WorktreeAction;
  sending: WorktreeAction | undefined;
  onClick(): void;
}) {
  const action = actions[props.action];
  const busy = props.sending === props.action;
  const label = busy ? action.busy : action.label;
  return (
    <Tip label={action.tip} side="top">
      <button
        type="button"
        aria-label={label}
        aria-disabled={props.sending ? true : undefined}
        onClick={props.sending ? undefined : props.onClick}
        className={cn(stripControl, "shrink-0 text-ui text-muted-foreground")}
      >
        <Icon icon={action.icon} size={14} />
        <span className="max-sm:sr-only">{label}</span>
      </button>
    </Tip>
  );
}

/** A settled worktree, folded: "Worktree ready · fix/login-timeout · 4.2s", opening on its steps. */
export function WorktreeReadyLine(props: {
  progress: WorktreeCreationProgress;
  branch?: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="fx-view-in flex flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className={foldedLine}
      >
        <Icon
          icon={props.progress.state === "local" ? LaptopIcon : GitForkIcon}
          size={14}
          className="text-subtle-foreground"
        />
        <span className="min-w-0 truncate">{worktreeSummary(props.progress, props.branch)}</span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div
          id={panel}
          className="mt-1 w-full rounded-card py-1 pr-2 pl-3.5 shadow-[inset_0_0_0_1px_var(--border)]"
        >
          <StepList rows={worktreeStepRows(props.progress)} times />
          <DetailsLog lines={props.progress.details} />
        </div>
      )}
    </div>
  );
}

const stepIcons = {
  done: { icon: CheckCircleIcon, label: "Done", tone: "text-subtle-foreground" },
  failed: { icon: WarningCircleIcon, label: "Failed", tone: "text-status-failed" },
  stopped: { icon: StopCircleIcon, label: "Stopped", tone: "text-subtle-foreground" },
} as const;

/**
 * One line per step reached. The step in flight spins (checkout with its bar and percent); a
 * finished step's time shows on hover, and always once the details are open.
 */
function StepList(props: { rows: readonly WorktreeStepRow[]; times: boolean }) {
  return (
    <ol aria-label="Steps" className="flex flex-col">
      {props.rows.map((row) => (
        <li
          key={row.step}
          aria-current={row.state === "running" ? "step" : undefined}
          className="flex h-7 min-w-0 items-center gap-2 text-ui"
        >
          {row.state === "running" ? (
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <Spinner />
            </span>
          ) : (
            <Icon
              icon={stepIcons[row.state].icon}
              size={14}
              label={stepIcons[row.state].label}
              className={stepIcons[row.state].tone}
            />
          )}
          <span
            className={cn(
              "min-w-0 truncate",
              row.state === "running" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {row.label}
          </span>
          {row.percent !== undefined ? (
            <span className="ml-auto flex shrink-0 items-center gap-2.5">
              <ProgressBar label={row.label} value={row.percent} className="w-28" />
              <span className="w-9 text-right text-sm text-muted-foreground tabular-nums">
                {row.percent}%
              </span>
            </span>
          ) : (
            row.state !== "running" && (
              <span
                className={cn(
                  "ml-auto shrink-0 text-xs text-subtle-foreground tabular-nums",
                  !props.times && "opacity-0 group-hover:opacity-100",
                )}
              >
                {formatDuration(row.elapsedMs)}
              </span>
            )
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The daemon's redacted log, monospace and bounded: it scrolls inside, and follows new lines
 * while the reader is at its end.
 */
function DetailsLog(props: { id?: string; lines: readonly string[] }) {
  const log = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const count = props.lines.length;
  useLayoutEffect(() => {
    const element = log.current;
    if (element && pinned.current && count) element.scrollTop = element.scrollHeight;
  }, [count]);
  return (
    <pre
      ref={log}
      id={props.id}
      role="log"
      aria-label="Worktree details"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
      }}
      className="mt-1 mb-1.5 max-h-48 overflow-auto overscroll-contain rounded-sm bg-secondary px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground focus-ring"
    >
      {count ? props.lines.join("\n") : "Nothing logged yet."}
    </pre>
  );
}

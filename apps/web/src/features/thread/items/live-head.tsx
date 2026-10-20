import {
  askingLabel,
  livePlanStep,
  subagentBranchStates,
  timedWords,
  waitingOnSubagentsLabel,
  workingSubagentsText,
  type TurnActivity,
} from "@ace/ui-core";
import { useTreeWork } from "@/features/panels/index.ts";
import { useShownPlans } from "@/lib/use-plans.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { ElapsedTime } from "@/components/working-indicator.tsx";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { PauseCircleIcon } from "@phosphor-icons/react";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { useDescendantRequest } from "../composer/descendant-request.ts";
import { SystemRow } from "./system-row.tsx";
import { underline } from "./work-log-view.tsx";

/*
 * The live turn's one status line, at the top of its flow under its ask (DESIGN.md §8): one
 * muted `Working for 3m 6s` row over the same hairline, where the turn's "Worked for" stands once
 * it settles.
 * While the agent only waits on its subagents or its background commands the line steps aside:
 * the composer's strip says `Waiting for 3 subagents · 3m 6s`, with a Stop.
 * It reads the same `turnActivity` as every other surface, counting the whole tree. The timer
 * writes its text through a ref, so a ticking second re-renders nothing, and it stands at the
 * time reached while the turn waits on the person (that time comes from the thread, so a redrawn
 * line shows it too).
 */

export function LiveHead(props: { threadId: string }) {
  const turn = useTurnActivity(props.threadId);
  // The thread's tree waits on a delegated child's request: say what that request asks for.
  const descendant = useDescendantRequest(props.threadId);
  const activity =
    turn?.tone === "needs-you" && descendant?.kind && turn.asker === descendant.name
      ? { ...turn, label: askingLabel(descendant.kind) }
      : turn;
  const plans = useShownPlans(props.threadId);
  const live = useLiveConnection();
  const progress = plans[0] ? livePlanStep(plans[0].progress) : undefined;
  const subagents = useWorkingSubagents(props.threadId, activity?.subagents);
  // A pause is the turn's own row; a lost connection is the header's to say; what the agent
  // only waits on is the composer's strip, with its Stop; a question the agent asked is its own
  // "is asking" line, which is the waiting state.
  if (
    !activity ||
    activity.tone === "paused" ||
    live.staleLabel ||
    activity.waitingOn ||
    (activity.askedInline && activity === turn)
  )
    return null;
  // The status line stays a live region of its own; its text can be selected.
  return (
    <div role="group" aria-label="Turn in progress" className="min-w-0">
      <ActivityLine activity={activity} progress={progress} subagents={subagents} />
      <div aria-hidden className={underline} />
    </div>
  );
}

/**
 * The live line, muted text with no glyph: `Working for 1m 14s`; `Waiting for 2 subagents ·
 * 1m 14s` while the agent only waits on its subagents; `(!) Waiting for your answer`
 * while the person is asked (the request itself is in the composer's strip); a held line as it
 * is; a usage-limit pause as a quiet row.
 */
export function ActivityLine(props: {
  activity: TurnActivity;
  progress?: string | undefined;
  /** Subagents still working, by the shared rule; the activity's own count otherwise. */
  subagents?: number | undefined;
}) {
  const subagents = props.subagents ?? props.activity.subagents ?? 0;
  // Counted as the subagents block counts them, so the label and the block agree.
  const activity = props.activity.waitingOnSubagents
    ? { ...props.activity, label: waitingOnSubagentsLabel(subagents) }
    : props.activity;
  if (activity.tone === "paused")
    return (
      <SystemRow
        role="status"
        text={activity.label}
        icon={<PauseCircleIcon aria-hidden size={14} />}
      />
    );
  const label = activity.code
    ? `${activity.label} ${activity.code}`
    : activity.tone === "needs-you" && activity.asker
      ? `${activity.label} · ${activity.asker}`
      : activity.label;
  return (
    <p
      role="status"
      aria-label={label}
      className="@container/live flex min-h-8 min-w-0 items-center text-ui text-muted-foreground"
    >
      {activity.tone === "working" ? (
        // Words and time only: the moving glyph is the sidebar's, not the transcript's.
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">
            {activity.elapsedFrom === undefined ? (
              activity.label
            ) : (
              <>
                {`${timedWords(activity.label)} `}
                <ElapsedTime from={activity.elapsedFrom} />
              </>
            )}
          </span>
          <Context
            activity={activity}
            progress={props.progress}
            subagents={activity.waitingOnSubagents ? 0 : subagents}
          />
        </span>
      ) : activity.tone === "needs-you" ? (
        // Waiting on the person outranks working: never "Working", no timer. The request
        // itself sits in the composer's strip.
        <span className="flex min-w-0 items-center gap-2">
          <StatusGlyph state="needs-you" />
          <span className="min-w-0 truncate">{label}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </p>
  );
}

/**
 * The main agent's subagents still at work, counted as the subagents block and the Summary count
 * them (`subagentBranchStates`); before the agents load, the daemon's own count.
 */
function useWorkingSubagents(threadId: string, fallback: number | undefined): number {
  const { agents, work } = useTreeWork(threadId);
  const states = subagentBranchStates(agents, work);
  return states.length ? states.filter((state) => state === "working").length : (fallback ?? 0);
}

/**
 * What else the whole tree is doing, quietly after the time: the plan's step, the subagents
 * still working ("2 subagents working", in the block's words) unless the label already counts
 * them, background commands.
 */
function Context(props: {
  activity: TurnActivity;
  progress: string | undefined;
  subagents: number;
}) {
  const { activity } = props;
  const commands = activity.backgroundCommands;
  const parts = [
    props.progress,
    props.subagents ? workingSubagentsText(props.subagents) : undefined,
  ].filter(Boolean);
  if (!parts.length && !commands) return null;
  return (
    <span className="min-w-0 truncate">
      {` · ${parts.join(" · ")}`}
      {commands ? (
        <>
          {parts.length ? " · " : ""}
          {commands} {/* A narrow column says "1 command": the line keeps its counts whole. */}
          <span className="@max-[30rem]/live:hidden">background </span>
          {commands === 1 ? "command" : "commands"}
        </>
      ) : null}
    </span>
  );
}

import {
  subagentBranchStates,
  timedWords,
  waitingOnSubagentsLabel,
  type TurnActivity,
} from "@ace/ui-core";
import { useSuitLabel } from "@/theme/suits/suit-labels.ts";
import { useTreeWork } from "@/features/panels/index.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { ElapsedTime } from "@/components/working-indicator.tsx";
import { PauseCircleIcon } from "@ace/icons";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { SystemRow } from "./system-row.tsx";
import { underline } from "./work-log-view.tsx";

/*
 * The live turn's one status line, at the top of its flow under its ask (DESIGN.md §8): one
 * muted `Working for 3m 6s` row over the same hairline, where the turn's "Worked for" stands once
 * it settles.
 * While the agent only waits on its subagents or its background commands the line steps aside:
 * the composer's strip says `Waiting for 3 subagents · 3m 6s`, with a Stop. Waiting on the person
 * lives in Summary and the composer's strip, never on this line: if the root itself is still
 * working while a child waits on the person, the line keeps showing `Working for …`; otherwise it
 * steps aside.
 * It reads the same `turnActivity` as every other surface, counting the whole tree. The timer
 * writes its text through a ref, so a ticking second re-renders nothing.
 */

export function LiveHead(props: { threadId: string }) {
  const turn = useTurnActivity(props.threadId);
  // A lost connection is the header's to say: no live line here. A copy catching up or read
  // from disk shows its live line, which then says "Syncing…" (`useTurnActivity`), not a turn.
  const live = useLiveConnection();
  const subagents = useWorkingSubagents(props.threadId, turn?.subagents);
  // Waiting on the person lives in Summary and the composer's strip, never on this line: show
  // the root's own work if it is still working while a child asks, otherwise step aside.
  const activity: TurnActivity | undefined =
    turn?.tone === "needs-you"
      ? turn.rootWorking
        ? {
            label: turn.rootWorking.label,
            tone: "working",
            elapsedFrom: turn.rootWorking.elapsedFrom,
            current: undefined,
          }
        : undefined
      : turn;
  // A pause is the turn's own row; a lost connection is the header's to say; what the agent
  // only waits on is the composer's strip, with its Stop.
  if (!activity || activity.tone === "paused" || live.staleLabel || activity.waitingOn) return null;
  // The status line stays a live region of its own; its text can be selected.
  return (
    <div role="group" aria-label="Turn in progress" className="min-w-0">
      <ActivityLine activity={activity} subagents={subagents} />
      <div aria-hidden className={underline} />
    </div>
  );
}

/**
 * The live line, muted text with no glyph and nothing after the time: `Working for 1m 14s`;
 * a held line as it is; a usage-limit pause as a quiet row. Never renders a waiting-on-you line,
 * which lives in Summary and the composer's strip.
 */
export function ActivityLine(props: {
  activity: TurnActivity;
  /** Subagents still working, by the shared rule; the activity's own count otherwise. */
  subagents?: number | undefined;
}) {
  const subagents = props.subagents ?? props.activity.subagents ?? 0;
  // Counted as the subagents block counts them, so the label and the block agree.
  const activity = props.activity.waitingOnSubagents
    ? { ...props.activity, label: waitingOnSubagentsLabel(subagents) }
    : props.activity;
  // A Suit may say its own word for plain "Working"; any other line is ace's (`suitLabel`).
  const working = useSuitLabel("working-word", activity.label);
  if (activity.tone === "needs-you") return null;
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
    : activity.tone === "working"
      ? working
      : activity.label;
  return (
    <p
      role="status"
      aria-label={label}
      data-part="working-line"
      data-state={activity.tone === "working" ? "working" : "waiting"}
      className="@container/live flex min-h-8 min-w-0 items-center text-ui text-muted-foreground"
    >
      {activity.tone === "working" ? (
        // Words and time only, never the current action, plan step or counts: those are the
        // work log's and the Summary's. The moving glyph is the sidebar's, not the transcript's.
        <span className="min-w-0 truncate">
          {activity.elapsedFrom === undefined ? (
            working
          ) : (
            <>
              {`${timedWords(working)} `}
              <ElapsedTime from={activity.elapsedFrom} />
            </>
          )}
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

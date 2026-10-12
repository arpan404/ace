import { formatElapsed, livePlanStep, type TurnActivity } from "@ace/ui-core";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useShownPlans } from "@/lib/use-plans.ts";
import { TimeContext } from "@/lib/time.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";

/*
 * The live turn's header, right under the ask that started it: "Working for 1m 14s · Running
 * bun install · 2 subagents". It reads the same `turnActivity` as every other surface, counting
 * the whole tree. The timer writes its text through a ref, so a ticking second re-renders
 * nothing, and it stands still while the turn waits on the person.
 */

export function LiveHead(props: { threadId: string }) {
  const activity = useTurnActivity(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const plans = useShownPlans(props.threadId);
  const progress = plans[0] ? livePlanStep(plans[0].progress) : undefined;
  if (!activity) return null;
  if (activity.tone === "paused") return null;
  return (
    <button
      type="button"
      aria-label="Open work and agents"
      onClick={() => workspace.open({ kind: "work" })}
      className="block w-full rounded-md py-1 text-left focus-ring"
    >
      <ActivityLine activity={activity} progress={progress} />
    </button>
  );
}

/**
 * "1m 14s" since `from`, written straight into the element on the page's shared one-second
 * clock: no React render per tick. Without `from` it stops and keeps the time it reached.
 */
function Elapsed(props: { from: number | undefined }) {
  const element = useRef<HTMLSpanElement>(null);
  const { seconds } = useContext(TimeContext);
  const { from } = props;
  useLayoutEffect(() => {
    if (from === undefined) return;
    const write = () => {
      if (element.current)
        element.current.textContent = formatElapsed(Math.max(0, seconds.read() - from));
    };
    write();
    return seconds.subscribe(write);
  }, [seconds, from]);
  return <span ref={element} className="tabular-nums" />;
}

/**
 * The live line. Working moves (spinner, the step's shimmer, the timer); waiting on the person
 * keeps the time it had reached and says what it waits for; held lines stay still; a usage-limit
 * pause is a divider.
 */
export function ActivityLine(props: { activity: TurnActivity; progress?: string | undefined }) {
  const { activity } = props;
  const timed = activity.tone === "working" && activity.elapsedFrom !== undefined;
  // Whether the timer ran before a wait: then the wait shows the time it stopped at.
  const [ran, setRan] = useState(timed);
  if (timed && !ran) setRan(true);
  if (activity.tone === "paused")
    return (
      <Marker role="status" aria-label={activity.label} variant="separator" className="text-xs">
        <MarkerContent>{activity.label}</MarkerContent>
      </Marker>
    );
  const label = activity.code ? `${activity.label} ${activity.code}` : activity.label;
  if (activity.tone === "held")
    return (
      <p role="status" aria-label={label} className="flex min-w-0 items-center gap-2 text-[13.5px]">
        <Icon icon={HourglassMediumIcon} size={14} className="text-subtle-foreground" />
        <span className="shrink-0 text-muted-foreground">{activity.label}</span>
        {activity.code && (
          <code className="min-w-0 truncate font-mono text-sm text-foreground">
            {activity.code}
          </code>
        )}
      </p>
    );
  const working = activity.tone === "working";
  const clock = working ? timed : ran;
  return (
    <p
      role="status"
      aria-label={label}
      className="fx-view-in flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]"
    >
      {working ? <Spinner /> : <Dot tone="needs-you" />}
      {clock ? (
        // One element across working and waiting, so the stopped time stays as it was.
        <span className={working ? "shrink-0 text-foreground" : "shrink-0 text-muted-foreground"}>
          {working ? `${activity.label} for ` : "Working for "}
          <Elapsed from={working ? activity.elapsedFrom : undefined} />
          {working ? "" : " · "}
        </span>
      ) : (
        <span className="shrink-0 text-foreground">{working ? activity.label : ""}</span>
      )}
      {working ? (
        activity.current && (
          <span className="min-w-0 truncate text-muted-foreground">
            ·{" "}
            <span key={activity.current} className="shimmer">
              {activity.current}
            </span>
          </span>
        )
      ) : (
        <span className="text-foreground">{activity.label}</span>
      )}
      <Counts activity={activity} progress={working ? props.progress : undefined} />
    </p>
  );
}

function Counts(props: { activity: TurnActivity; progress: string | undefined }) {
  const { activity } = props;
  return (
    <>
      {props.progress && (
        <span className="min-w-0 truncate text-muted-foreground">· {props.progress}</span>
      )}
      {!!activity.subagents && (
        <span className="shrink-0 text-muted-foreground">
          · {activity.subagents} {activity.subagents === 1 ? "subagent" : "subagents"}
        </span>
      )}
      {!!activity.backgroundCommands && (
        <span className="shrink-0 text-muted-foreground">
          · {activity.backgroundCommands}{" "}
          {activity.backgroundCommands === 1 ? "background command" : "background commands"}
        </span>
      )}
    </>
  );
}

import { activityText, type TurnActivity } from "@ace/ui-core";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";

/** The turn's live status stays at the transcript's end until its whole tree settles. */
export function LiveFooter(props: { threadId: string; activity: TurnActivity | undefined }) {
  const workspace = useWorkspaceActions(props.threadId);
  if (!props.activity) return null;
  return (
    <button
      type="button"
      aria-label="Open work and agents"
      onClick={() => workspace.open({ kind: "agents" })}
      className="block w-full rounded-md py-2 text-left focus-ring"
    >
      <ActivityLine activity={props.activity} />
    </button>
  );
}

/**
 * The live line: "Working for 1m 14s · Running bun install" moves (spinner, shimmer, a timer);
 * waiting on the person shows the needs-you mark and no timer; held lines stay still; a usage
 * limit pause is a divider.
 */
export function ActivityLine(props: { activity: TurnActivity }) {
  const { activity } = props;
  const now = useTicker(activity.elapsedFrom !== undefined);
  const text = activityText(activity, now);
  if (activity.tone === "paused")
    return (
      <Marker role="status" aria-label={text} variant="separator" className="text-xs">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    );
  return (
    <p
      role="status"
      aria-label={activity.code ? `${activity.label} ${activity.code}` : activity.label}
      className="fx-view-in flex min-w-0 items-center flex-wrap gap-x-2 gap-y-1 text-[13.5px]"
    >
      {activity.tone === "working" ? (
        <>
          <Spinner />
          <span className="shrink-0 shimmer tabular-nums">{text}</span>
          {activity.current && (
            <span className="min-w-0 truncate text-muted-foreground">· {activity.current}</span>
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
      ) : activity.tone === "needs-you" ? (
        <>
          <Dot tone="needs-you" />
          <span className="text-foreground">{text}</span>
        </>
      ) : (
        <>
          <Icon icon={HourglassMediumIcon} size={14} className="text-subtle-foreground" />
          <span className="shrink-0 text-muted-foreground">{activity.label}</span>
          {activity.code && (
            <code className="min-w-0 truncate font-mono text-sm text-foreground">
              {activity.code}
            </code>
          )}
        </>
      )}
    </p>
  );
}

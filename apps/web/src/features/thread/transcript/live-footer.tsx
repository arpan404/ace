import { activityText, type TurnActivity } from "@ace/ui-core";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useTicker } from "../lib/clock.ts";

/**
 * Below the last block: waiting and held context. Transient working status stays on the
 * composer. The agent's open requests are answered there as attached cards.
 */
export function LiveFooter(props: { activity: TurnActivity | undefined }) {
  const { activity } = props;
  if (
    !activity ||
    activity.tone === "working" ||
    activity.tone === "needs-you" ||
    activity.label.startsWith("Watching")
  )
    return null;
  return (
    <div className="flex flex-col gap-3 pb-2">
      <ActivityLine activity={activity} />
    </div>
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
      className="fx-view-in flex min-w-0 items-center gap-[9px] text-[13.5px]"
    >
      {activity.tone === "working" ? (
        <>
          <Spinner />
          <span className="shrink-0 shimmer tabular-nums">{text}</span>
          {activity.current && (
            <span className="min-w-0 truncate text-muted-foreground">· {activity.current}</span>
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

import { useInteractions } from "@ace/client-react";
import { activityText, type TurnActivity } from "@ace/ui-core";
import { Suspense } from "react";
import { HourglassMediumIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { DeferredInteractionCard } from "../deferred.ts";
import { useTicker } from "../lib/clock.ts";

const InteractionCard = DeferredInteractionCard.Component;

const noneShown: ReadonlySet<string> = new Set();

/**
 * Below the last block: open requests to answer, then the turn's live line. `activity` is left
 * out when the bottom work log already carries the line as its header. Requests in `inline`
 * already sit in the transcript where they were asked.
 */
export function LiveFooter(props: {
  threadId: string;
  activity: TurnActivity | undefined;
  inline?: ReadonlySet<string>;
}) {
  const inline = props.inline ?? noneShown;
  const pending = (useInteractions(props.threadId) ?? []).filter((id) => !inline.has(id));
  const { activity } = props;
  if (!pending.length && !activity) return null;
  return (
    <div className="flex flex-col gap-3 pb-2">
      {pending.length > 0 && (
        <Suspense fallback={null}>
          {pending.map((id) => (
            <InteractionCard key={id} threadId={props.threadId} interactionId={id} />
          ))}
        </Suspense>
      )}
      {activity && <ActivityLine activity={activity} />}
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
      aria-label={activity.label}
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
          <span className="text-muted-foreground">{text}</span>
        </>
      )}
    </p>
  );
}

import { oneLine, sanitizeUserText } from "@ace/ui-core";
import { useMemo, useRef, type RefObject } from "react";
import { useElementSize } from "@/lib/element-size.ts";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { ConversationRail, minTickSpacing } from "./conversation-rail.tsx";
import { useWatched, type ThreadNav } from "./nav.tsx";
import { useTurnHead, useTurnSummary } from "./turn-index.ts";
import { railOrdinals } from "./rail-ordinals.ts";

/** Turns before the rail shows: a shorter thread is quicker to scroll than to outline. */
const railTurns = 6;
/** A wheel's lines and pages, in pixels. */
const wheelLine = 16;

/** A vertical wheel over the rail scrolls the transcript instead. */
function forwardWheel(event: WheelEvent, target: HTMLElement | null | undefined): void {
  // Pinch zoom and sideways scrolling stay the browser's.
  if (!target || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? target.clientHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? wheelLine
        : 1;
  target.scrollBy({ top: event.deltaY * unit });
}

export function TurnRail({
  nav,
  scroller,
}: {
  nav: ThreadNav;
  /** The transcript beside the rail: a wheel over the rail scrolls it. */
  scroller?: RefObject<HTMLElement | null>;
}) {
  const head = useTurnHead(nav.threadId);
  const count = head?.count ?? 0;
  const current = useWatched(nav.currentTurn);
  const following = useWatched(nav.following);
  const reading = following ? count : (current ?? count);
  const box = useRef<HTMLDivElement>(null);
  const height = useElementSize(box).height;
  // No more turns than fit the rail at its closest spacing: it never scrolls.
  const fit = Math.floor(height / minTickSpacing) + 1;
  const markers = useMemo(
    () =>
      railOrdinals(count, reading, fit).map((ordinal) => ({
        id: String(ordinal),
        label: `Turn ${ordinal}`,
        ordinal,
      })),
    [count, reading, fit],
  );
  if (count < railTurns) return null;
  return (
    <div ref={box} className="absolute top-20 bottom-24 left-0 z-[6] grid place-items-center">
      <ConversationRail
        markers={markers}
        height={height}
        onWheel={(event) => forwardWheel(event, scroller?.current)}
        currentId={String(reading)}
        onJump={(id) => {
          void nav.jump.toTurn(Number(id));
        }}
        renderPreview={(id) => <TurnPreview threadId={nav.threadId} ordinal={Number(id)} />}
      />
    </div>
  );
}

/**
 * The turn at a glance: the ask on one line, the reply's opening lines under it. Only the open
 * marker reads its cached index block; no transcript window is fetched.
 */
function TurnPreview({ threadId, ordinal }: { threadId: string; ordinal: number }) {
  const turn = useTurnSummary(threadId, ordinal);
  if (!turn)
    return (
      <div aria-label="Loading turn preview" className="space-y-2">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-3 w-56" />
      </div>
    );
  const ask = oneLine(sanitizeUserText(turn.initiatingMessagePreview ?? ""));
  const reply = oneLine(sanitizeUserText(turn.latestAgentMessagePreview ?? ""));
  return (
    <div className="space-y-1">
      <p className="truncate text-ui font-medium text-foreground">{ask || "No text in this ask"}</p>
      <p className="line-clamp-3 text-ui break-words text-subtle-foreground">
        {reply || "No reply yet"}
      </p>
    </div>
  );
}

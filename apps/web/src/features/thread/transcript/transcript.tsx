import {
  ThreadWindowProvider,
  useHistoryPager,
  useItemOrder,
  useThreadStore,
  type HistoryPager,
} from "@ace/client-react";
import { useEffect, useMemo, useState } from "react";
import { useThreadNav, useJumpState, useWatched } from "../long/nav.tsx";
import { Feed } from "./feed.tsx";

const none: readonly string[] = [];

/**
 * How many items reached the live tail since the reader left its end (scrolled up or jumped),
 * and whether more arrived than the tail holds.
 */
function useNewSince(order: readonly string[], away: boolean): { count: number; more: boolean } {
  const [mark, setMark] = useState<{ away: boolean; last: string | undefined }>({
    away,
    last: undefined,
  });
  if (mark.away !== away) setMark({ away, last: away ? order.at(-1) : undefined });
  if (!away || mark.last === undefined) return { count: 0, more: false };
  const at = order.lastIndexOf(mark.last);
  return at < 0
    ? { count: order.length, more: true }
    : { count: order.length - 1 - at, more: false };
}

/**
 * The reading column: a virtualized feed over the thread's leased live tail (ADR 0006) or, after
 * a jump, over one window of older history (ADR 0062), never both with a hole between them.
 * Older turns fold into digest rows; the reader follows the live end until they scroll away,
 * and Jump to live says how much arrived meanwhile.
 */
export function Transcript(props: { threadId: string }) {
  const nav = useThreadNav();
  const jump = useJumpState(nav.jump);
  const live = useThreadStore(props.threadId);
  const liveOrder = useItemOrder(props.threadId) ?? none;
  const livePager = useHistoryPager(props.threadId);
  const following = useWatched(nav.following);
  const window = jump.window;
  const source = useMemo(
    () => (live && window ? nav.jump.source(live, window, jump.joined) : undefined),
    [nav.jump, live, window, jump.joined],
  );
  // A joined window stops overlapping when far more arrives than the tail holds.
  const tailEnd = liveOrder.at(-1);
  useEffect(() => {
    if (tailEnd !== undefined) nav.jump.tailMoved();
  }, [nav.jump, tailEnd]);
  // A new jump reads from its own turn until the reader scrolls it.
  const landed = jump.focus?.nonce;
  useEffect(() => {
    if (landed !== undefined && jump.turn !== undefined) nav.currentTurn.set(jump.turn);
  }, [nav.currentTurn, jump.turn, landed]);
  const fresh = useNewSince(liveOrder, !following || !!window);
  const pager: HistoryPager = window
    ? {
        hasOlder: window.before !== null,
        loading: jump.loading === "older",
        error: undefined,
        loadOlder: () => nav.jump.older(),
      }
    : livePager;
  return (
    <ThreadWindowProvider threadId={props.threadId} source={source}>
      <Feed
        threadId={props.threadId}
        nav={nav}
        jump={jump}
        pager={pager}
        seqTurns={jump.turns}
        fresh={fresh}
        liveNewest={liveOrder.at(-1)}
      />
    </ThreadWindowProvider>
  );
}

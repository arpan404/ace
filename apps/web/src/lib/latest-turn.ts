import type { ClientApi, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { TurnSummary } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";
import { useDaemonQuery } from "./daemon-query.ts";

/** At most one read of the newest turn this often while the thread's events stream in. */
const refreshMs = 2_000;

const readCursor = (reader: ThreadReader) => reader.cursor;

/**
 * The thread's live cursor, passed on at most once per `refreshMs`: the first change after a
 * quiet spell lands at once, a steady stream of events then moves it once per period, and the
 * last change always lands. No timer runs while nothing changes.
 */
function useSettledCursor(threadId: string): number | undefined {
  const cursor = useThread(threadId, ["cursor"], readCursor);
  const [settled, setSettled] = useState(cursor);
  const latest = useRef(cursor);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    latest.current = cursor;
    if (timer.current !== undefined) {
      pending.current = true;
      return;
    }
    setSettled(cursor);
    const tick = () => {
      if (!pending.current) {
        timer.current = undefined;
        return;
      }
      pending.current = false;
      setSettled(latest.current);
      timer.current = setTimeout(tick, refreshMs);
    };
    timer.current = setTimeout(tick, refreshMs);
  }, [cursor]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    [],
  );
  return settled;
}

/**
 * The thread's newest turn from the turn index (ADR 0062): one bounded `turns.page` read of a
 * single summary, read again as the thread moves on, so its digest (files, commands, approvals,
 * per-agent shares) keeps up with a turn in progress without reading any history.
 */
export function useLatestTurn(threadId: string): TurnSummary | undefined {
  const cursor = useSettledCursor(threadId);
  const query = useDaemonQuery<TurnSummary | null>({
    queryKey: ["thread-turns", threadId, "latest", cursor ?? 0],
    read: async (client: ClientApi, signal) => {
      const page = await client.turnsPage({ threadId, limit: 1 }, { signal });
      return page.turns.at(-1) ?? null;
    },
    staleTime: 30_000,
    gcTime: 20_000,
    // Keep the last summary on screen while the next read lands.
    placeholderData: (previous) => previous,
  });
  return query.data ?? undefined;
}

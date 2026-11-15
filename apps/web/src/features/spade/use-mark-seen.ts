import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { markSeen } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { groupsKey } from "./use-spade-groups.ts";
import { agentsKey } from "./use-spade-roster.ts";

/** A conversation the person may be looking at, and whether Spade counts it unseen. */
export interface SeenTarget {
  conversation: string;
  unseen: boolean;
  /** Its latest message's event, to mark seen up to; undefined marks up to the last event. */
  seq: number | undefined;
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Marks a conversation seen once the person has it open at its end in a visible window, while
 * Spade counts it unseen; the list reads again so its row settles. Each latest message is sent
 * once; a mark that fails is tried again the next time they're at the end. Returns the report
 * the scroller calls with whether it is at its end.
 */
export function useMarkSeen(target: SeenTarget | undefined): (atEnd: boolean) => void {
  const client = useSpadeClient();
  const queries = useQueryClient();
  const atEnd = useRef(false);
  const sent = useRef<string | undefined>(undefined);
  const latest = useRef(target);
  // Before the effects below read it.
  useLayoutEffect(() => {
    latest.current = target;
  });
  const mark = useCallback(() => {
    const now = latest.current;
    if (!now?.unseen || !atEnd.current || !visible()) return;
    const key = `${now.conversation}:${now.seq ?? "end"}`;
    if (sent.current === key) return;
    sent.current = key;
    markSeen(client, now.conversation, now.seq).then(
      () => {
        void queries.invalidateQueries({ queryKey: agentsKey });
        void queries.invalidateQueries({ queryKey: groupsKey });
      },
      () => {
        if (sent.current === key) sent.current = undefined;
      },
    );
  }, [client, queries]);
  // Spade says it's unseen while the person is already at the end (it just finished).
  useEffect(mark, [mark, target?.conversation, target?.unseen, target?.seq]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [mark]);
  return useCallback(
    (end: boolean) => {
      atEnd.current = end;
      mark();
    },
    [mark],
  );
}

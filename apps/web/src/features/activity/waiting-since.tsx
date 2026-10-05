import type { SidebarReader, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useThreadIdsWhere } from "@/features/shell/index.ts";
import { useDeckEvents } from "./escalations.ts";

/** When a thread's oldest open request was made: the moment it started waiting on you. */
function oldestPending(reader: ThreadReader): number | undefined {
  let oldest: number | undefined;
  for (const id of reader.interactionIds()) {
    const interaction = reader.interaction(id);
    if (
      interaction?.state === "pending" &&
      (oldest === undefined || interaction.createdAt < oldest)
    )
      oldest = interaction.createdAt;
  }
  return oldest;
}

const needsYou = (reader: SidebarReader, id: string) =>
  reader.thread(id)?.status.state === "needs_you";

const Context = createContext<ReadonlyMap<string, number>>(new Map());

/**
 * Since when each waiting thread has waited, read from its own requests, so Needs you can be
 * listed oldest first the same way in the sidebar and the main column.
 */
export function WaitingSinceProvider(props: { children: ReactNode }) {
  // A deck's own threads wait as the deck's decision, which has its own time.
  const owned = useDeckEvents().threads;
  const ids = useThreadIdsWhere(needsYou).filter((id) => !owned.has(id));
  const [since, setSince] = useState<ReadonlyMap<string, number>>(() => new Map());
  const report = useCallback(
    (threadId: string, at: number) =>
      setSince((current) =>
        current.get(threadId) === at ? current : new Map(current).set(threadId, at),
      ),
    [],
  );
  // A thread that stops waiting unmounts its reporter, which drops its entry: the map holds
  // only what waits now.
  const forget = useCallback(
    (threadId: string) =>
      setSince((current) => {
        if (!current.has(threadId)) return current;
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
    [],
  );
  return (
    <Context.Provider value={since}>
      {ids.map((id) => (
        <Reporter key={id} threadId={id} report={report} forget={forget} />
      ))}
      {props.children}
    </Context.Provider>
  );
}

function Reporter(props: {
  threadId: string;
  report(threadId: string, at: number): void;
  forget(threadId: string): void;
}) {
  const at = useThread(props.threadId, ["interactions"], oldestPending);
  const { threadId, report, forget } = props;
  useEffect(() => () => forget(threadId), [threadId, forget]);
  useEffect(() => {
    if (at !== undefined) report(threadId, at);
  }, [threadId, at, report]);
  return null;
}

/** Each waiting thread's start of waiting, by thread id (missing until its requests load). */
export function useWaitingSince(): ReadonlyMap<string, number> {
  return useContext(Context);
}

import {
  OptionalLeaseScope,
  useThreadError,
  useThreadMeta,
  useThreadRoom,
  useThreadSyncing,
  useThreadUnconfirmed,
} from "@ace/client-react";
import { agentForest, forestLayers, type AgentForest, type ThreadWork } from "@ace/ui-core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTreeWork } from "../agents/use-tree-work.ts";

type Report = (threadId: string, work: ThreadWork | undefined) => void;

const noAgents: ThreadWork["agents"] = [];

/**
 * How current a thread's facts are, from its subscription's own flags. A new store starts with
 * neither flag set and nothing in it: until its first view arrives it is syncing, never live.
 */
function useFacts(threadId: string): NonNullable<ThreadWork["facts"]> {
  const error = useThreadError(threadId);
  const syncing = useThreadSyncing(threadId);
  const unconfirmed = useThreadUnconfirmed(threadId);
  const viewed = useThreadMeta(threadId) !== undefined;
  if (error) return "not_loaded";
  return !viewed || syncing || unconfirmed ? "syncing" : "live";
}

/** One thread's live entities and how current they are, for the forest. */
function useThreadWork(threadId: string): ThreadWork {
  const facts = useTreeWork(threadId);
  const state = useFacts(threadId);
  return useMemo<ThreadWork>(
    () =>
      state === "not_loaded"
        ? { agents: noAgents, tasks: [], interactions: [], facts: state }
        : {
            agents: facts.agents,
            tasks: facts.tasks,
            interactions: facts.interactions,
            status: facts.status,
            facts: state,
          },
    [facts.agents, facts.tasks, facts.interactions, facts.status, state],
  );
}

/**
 * Holds one delegated thread's subscription while it is mounted and hands its live entities up.
 * It draws nothing; the client shares the wire subscription with any other view of the thread.
 */
function ThreadWorkLoader(props: { threadId: string; report: Report }) {
  const { threadId, report } = props;
  const work = useThreadWork(threadId);
  useEffect(() => report(threadId, work), [threadId, work, report]);
  useEffect(() => () => report(threadId, undefined), [threadId, report]);
  return null;
}

/**
 * A delegated thread's loader that tries again when the client has room: a thread refused for
 * room (or given up for one the person opened) holds again when room frees, once per rise.
 */
function RetryingLoader(props: {
  threadId: string;
  report: Report;
  refused: boolean;
  room: number;
}) {
  const { refused, room } = props;
  const [attempt, setAttempt] = useState(0);
  // The room it last tried at: one try per room the client has, cleared once room runs out.
  const tried = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (room <= 0) tried.current = undefined;
    if (!refused || room <= 0 || tried.current === room) return;
    tried.current = room;
    setAttempt((count) => count + 1);
  }, [room, refused]);
  return <ThreadWorkLoader key={attempt} threadId={props.threadId} report={props.report} />;
}

/**
 * The thread's agents with every delegated thread's agents under their delegates (ADR 0108).
 * Each delegated thread the tree reaches is subscribed to only while the caller is mounted (the
 * Summary tab), within `forestBounds`, through optional leases: they take only spare room, give
 * it up for a thread the person opens, and come back when room frees. `loaders` holds those
 * subscriptions and must be rendered, inside `OptionalLeaseScope` with the tree's rows.
 * A thread's facts change only that thread's entry, and unchanged threads keep their layer.
 */
export function useAgentForest(threadId: string): {
  forest: AgentForest;
  works: ReadonlyMap<string, ThreadWork>;
  loaders: ReactNode;
} {
  const own = useThreadWork(threadId);
  const room = useThreadRoom();
  const [layers] = useState(forestLayers);
  const [children, setChildren] = useState<ReadonlyMap<string, ThreadWork>>(new Map());
  const report = useCallback<Report>((id, work) => {
    setChildren((current) => {
      if (current.get(id) === work) return current;
      const next = new Map(current);
      if (work) next.set(id, work);
      else next.delete(id);
      return next;
    });
  }, []);
  const works = useMemo(() => {
    const all = new Map(children);
    // Its own thread is read here, never through a loader, even when a child delegates back.
    all.set(threadId, own);
    return all;
  }, [children, threadId, own]);
  const forest = useMemo(
    () => agentForest(threadId, works, undefined, layers),
    [threadId, works, layers],
  );
  const loaders = (
    <OptionalLeaseScope>
      {forest.reach.map((id) => (
        <RetryingLoader
          key={id}
          threadId={id}
          report={report}
          refused={children.get(id)?.facts === "not_loaded"}
          room={room}
        />
      ))}
    </OptionalLeaseScope>
  );
  return { forest, works, loaders };
}

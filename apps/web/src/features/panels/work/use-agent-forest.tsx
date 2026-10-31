import { agentForest, type AgentForest, type ThreadWork } from "@ace/ui-core";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTreeWork } from "../agents/use-tree-work.ts";

type Report = (threadId: string, work: ThreadWork | undefined) => void;

/**
 * Holds one delegated thread's subscription while it is mounted and hands its live entities up.
 * It draws nothing; the client shares the wire subscription with any other view of the thread.
 */
function ThreadWorkLoader(props: { threadId: string; report: Report }) {
  const { threadId, report } = props;
  const facts = useTreeWork(threadId);
  const work = useMemo<ThreadWork>(
    () => ({
      agents: facts.agents,
      tasks: facts.tasks,
      interactions: facts.interactions,
      status: facts.status,
    }),
    [facts.agents, facts.tasks, facts.interactions, facts.status],
  );
  useEffect(() => report(threadId, work), [threadId, work, report]);
  useEffect(() => () => report(threadId, undefined), [threadId, report]);
  return null;
}

/**
 * The thread's agents with every delegated thread's agents under their delegates (ADR 0107).
 * Each delegated thread the tree reaches is subscribed to only while the caller is mounted (the
 * Summary tab), within `forestBounds`; `loaders` holds those subscriptions and must be rendered.
 * A thread's facts change only that thread's entry, and the join is linear in loaded agents.
 */
export function useAgentForest(threadId: string): {
  forest: AgentForest;
  works: ReadonlyMap<string, ThreadWork>;
  loaders: ReactNode;
} {
  const own = useTreeWork(threadId);
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
    all.set(threadId, {
      agents: own.agents,
      tasks: own.tasks,
      interactions: own.interactions,
      status: own.status,
    });
    return all;
  }, [children, threadId, own.agents, own.tasks, own.interactions, own.status]);
  const forest = useMemo(() => agentForest(threadId, works), [threadId, works]);
  const loaders = forest.reach.map((id) => (
    <ThreadWorkLoader key={id} threadId={id} report={report} />
  ));
  return { forest, works, loaders };
}

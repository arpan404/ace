import type { ThreadReader } from "@ace/client";
import { useSidebarThread, useThread } from "@ace/client-react";
import { isRunning } from "@ace/ui-core";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { deckLaneTab, useThreadParts } from "./thread-parts.ts";

interface Counts {
  active: number;
  done: number;
}
const sameCounts = (a: Counts, b: Counts) => a.active === b.active && a.done === b.done;
/** Subagents only: the root agent is the conversation itself. */
const countSubagents = (reader: ThreadReader): Counts => {
  const counts = { active: 0, done: 0 };
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (!agent || agent.origin === "root") continue;
    if (isRunning(agent)) counts.active++;
    else counts.done++;
  }
  return counts;
};

/** "2 active · 4 done" above the tree; a quiet line when none is active. */
export function AgentCounts(props: { threadId: string }) {
  const counts = useThread(props.threadId, ["agents"], countSubagents, sameCounts);
  if (!counts || counts.active + counts.done === 0) return null;
  return (
    <p role="status" className="px-2 pt-1 pb-1.5 text-xs text-subtle-foreground tabular-nums">
      {counts.active ? `${counts.active} active` : "No active subagents"} · {counts.done} done
    </p>
  );
}

/** The deck this thread works for, with its lanes grouped under it, each opening as a tab. */
export function ThreadDeck(props: { threadId: string }) {
  const deck = useSidebarThread(props.threadId)?.deck;
  const workspace = useWorkspaceActions(props.threadId);
  const { DeckOfThread } = useThreadParts();
  if (!deck || !DeckOfThread) return null;
  return (
    <section aria-labelledby="agents-deck">
      <h3 id="agents-deck" className="px-2.5 pt-3 pb-1 text-xs font-medium text-subtle-foreground">
        Offshift
      </h3>
      <Suspense fallback={<Skeleton className="mx-2 my-2 h-4 w-48" />}>
        <DeckOfThread
          runId={deck.runId}
          threadId={props.threadId}
          onOpenLane={(lane) => workspace.open(deckLaneTab(lane))}
        />
      </Suspense>
    </section>
  );
}

import { useCallback, useMemo } from "react";
import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import {
  changesByAgent,
  forestTally,
  isActivelyRunning,
  latestChecks,
  offshiftSummary,
  queuedInputLine,
  summaryPullRequests,
  turnAgentFiles,
} from "@ace/ui-core";
import { useProjectAutomations, WorkAutomationsLine } from "@/features/automation-data/index.ts";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useLatestTurn } from "@/lib/latest-turn.ts";
import { useServerQueue } from "@/lib/server-queue.ts";
import { useShownPlans } from "@/lib/use-plans.ts";
import {
  attachWorkspaceScroll,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { SinceYouLooked, useShownCatchUp } from "./catch-up.tsx";
import { OffshiftRun } from "./offshift-run.tsx";
import { SummaryNow } from "./summary-now.tsx";
import { SummaryPlan } from "./summary-plan.tsx";
import { Results } from "./summary-results.tsx";
import { Section } from "./summary-section.tsx";
import { SummaryTree } from "./summary-tree.tsx";
import { useAgentForest } from "./use-agent-forest.tsx";

const queueOf = (reader: ThreadReader) => reader.queue;
const offshiftOf = (reader: ThreadReader) => reader.offshift;

/**
 * The thread at a glance, top to bottom: Now (one sentence and one grey line), an active
 * Offshift run, what happened since the person last looked, every agent of the thread and of the
 * threads it delegated, what came out of the work, the plan, and the project's automations in
 * one line. A section with nothing in it is left out. Everything reads bounded facts: the live
 * entities of each thread and the turn index's digests, never a thread's history.
 */
export default function WorkTab(props: TabViewProps) {
  const thread = useThreadMeta(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const { forest, works, loaders } = useAgentForest(props.scope);
  const own = works.get(props.scope);
  const page = useServerQueue(props.scope).page;
  const hold = useThread(props.scope, ["queue"], queueOf) ?? page;
  const card = useThread(props.scope, ["offshift"], offshiftOf);
  const plans = useShownPlans(props.scope);
  const turn = useLatestTurn(props.scope);
  const catchUp = useShownCatchUp(props.scope);
  const automations = useProjectAutomations(
    thread?.workspaceId ?? "",
    thread?.details?.workspace?.path,
  );
  const status = thread?.status;
  const live = thread?.live;
  const agents = own?.agents;
  const interactions = own?.interactions;
  // The run is shown against the whole tree, so it never reads Done while anything still runs.
  const run = useMemo(() => {
    if (!card || !status) return undefined;
    const request = interactions?.[0]?.request.kind;
    return offshiftSummary(card, {
      status,
      live,
      runningAgents: (agents ?? []).filter(isActivelyRunning).length,
      request: request === undefined ? undefined : request === "approval" ? "approval" : "question",
    });
  }, [card, status, live, agents, interactions]);
  const linked = thread?.details?.linkedPrs;
  const prs = useMemo(() => summaryPullRequests(linked ?? []), [linked]);
  const checks = useMemo(() => (turn ? latestChecks(turn.digest.commands) : []), [turn]);
  const worktree = thread?.details?.worktree ?? thread?.details?.workspace?.path ?? "";
  const changes = useMemo(() => {
    if (!turn) return changesByAgent([]);
    const cwd = new Map<string, string>((agents ?? []).map((agent) => [agent.id, agent.cwd]));
    return changesByAgent(turnAgentFiles(turn, (id) => cwd.get(id), worktree));
  }, [turn, agents, worktree]);
  const names = useMemo(
    () =>
      new Map(
        (turn?.subagents ?? []).flatMap((share) =>
          share.name ? [[share.agentId, share.name] as const] : [],
        ),
      ),
    [turn],
  );
  const saved = props.tab.ui?.scrollTop ?? 0;
  const scroll = useCallback(
    (node: HTMLDivElement | null) => {
      if (node)
        return attachWorkspaceScroll(node, saved, (scrollTop) =>
          actions.updateUi("work", { scrollTop }),
        );
    },
    [saved, actions],
  );
  if (!thread)
    return (
      // Rows shaped like the tab's, while the thread's facts arrive.
      <ListSkeleton label="summary" shape="row" rows={4} className="px-1.5 py-1.5" />
    );
  const queued = queuedInputLine({
    retained: page?.total ?? 0,
    queue: hold,
    status: thread.status,
    agentFailed: (agents ?? []).some(
      (agent) => agent.parentId === null && agent.status.state === "failed",
    ),
  });
  const total = forestTally(forest.roots);
  // A main agent alone says nothing Now hasn't: the tree shows once there is a tree.
  const tree = forest.roots.some((root) => root.children.length > 0) || forest.roots.length > 1;
  return (
    <div
      ref={scroll}
      data-summary
      data-work-scroll
      className="@container/summary flex h-full min-h-0 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain px-1.5 pt-2 pb-3"
    >
      {loaders}
      <SummaryNow
        threadId={props.scope}
        thread={thread}
        roots={forest.roots}
        works={works}
        turn={turn}
        prs={prs}
        queued={queued && `${queued.label} · ${queued.when}`}
      />
      {run && !run.done && (
        <Section name="Offshift">
          <OffshiftRun run={run} />
        </Section>
      )}
      {catchUp.catchUp && <SinceYouLooked catchUp={catchUp.catchUp} onDismiss={catchUp.dismiss} />}
      {tree && (
        <Section name="Agents" count={String(total.working + total.done)}>
          <SummaryTree threadId={props.scope} roots={forest.roots} works={works} />
        </Section>
      )}
      <Results
        threadId={props.scope}
        workspaceId={thread.workspaceId}
        prs={prs}
        turn={turn}
        changes={changes}
        names={names}
        checks={checks}
      />
      <SummaryPlan plans={plans} />
      <WorkAutomationsLine automations={automations} />
    </div>
  );
}

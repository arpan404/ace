import { useCallback, useMemo, type ReactNode } from "react";
import type { ThreadReader } from "@ace/client";
import { useAgentTree, useThread, useThreadMeta, type AgentTreeNode } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import {
  changesByAgent,
  latestChecks,
  needsYou,
  queuedInputLine,
  turnAgentFiles,
} from "@ace/ui-core";
import { useProjectAutomations, WorkAutomations } from "@/features/automations/index.ts";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useLatestTurn } from "@/lib/latest-turn.ts";
import { useServerQueue } from "@/lib/server-queue.ts";
import { useShownPlans } from "@/lib/use-plans.ts";
import {
  attachWorkspaceScroll,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { BackgroundList } from "../agents/background-list.tsx";
import { subagentCounts } from "../agents/subagents.ts";
import { AgentCounts } from "../agents/tree-extras.tsx";
import { TreeWorkContext } from "../agents/tree-work-context.ts";
import { useTreeWork } from "../agents/use-tree-work.ts";
import { WorkTree } from "../agents/work-tree.tsx";
import { AgentChanges } from "./agent-changes.tsx";
import { CatchUp, useShownCatchUp } from "./catch-up.tsx";
import { Checks } from "./checks.tsx";
import { NeedsYouList } from "./needs-you.tsx";
import { summarySections } from "./summary-sections.ts";
import { ThisTurn } from "./this-turn.tsx";
import { WorkPlans } from "./work-plans.tsx";

const queueOf = (reader: ThreadReader) => reader.queue;
const noNodes: readonly AgentTreeNode[] = [];

/**
 * The thread at a glance, only what is there, top to bottom: what needs the person, the latest
 * turn in counts, its plan, every agent and background command saying what it is doing, the
 * turn's changes by agent, its checks, and what happened while the person was away. Small labels
 * part the sections only when there is more than one. Everything reads bounded facts: the live
 * entities and the turn index's digests, never the thread's history.
 */
export default function WorkTab(props: TabViewProps) {
  const thread = useThreadMeta(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const facts = useTreeWork(props.scope);
  const tree = useAgentTree(props.scope) ?? noNodes;
  const page = useServerQueue(props.scope).page;
  const hold = useThread(props.scope, ["queue"], queueOf) ?? page;
  const plans = useShownPlans(props.scope).length;
  const turn = useLatestTurn(props.scope);
  const catchUp = useShownCatchUp(props.scope);
  const automations = useProjectAutomations(
    thread?.workspaceId ?? "",
    thread?.details?.workspace?.path,
  );
  const needs = useMemo(
    () => needsYou(facts.agents, facts.interactions),
    [facts.agents, facts.interactions],
  );
  const subagents = useMemo(() => subagentCounts(tree), [tree]);
  const checks = useMemo(() => (turn ? latestChecks(turn.digest.commands) : []), [turn]);
  const worktree = thread?.details?.worktree ?? thread?.details?.workspace?.path ?? "";
  const shares = useMemo(() => {
    if (!turn) return [];
    const cwd = new Map<string, string>(facts.agents.map((agent) => [agent.id, agent.cwd]));
    return turnAgentFiles(turn, (id) => cwd.get(id), worktree);
  }, [turn, facts.agents, worktree]);
  const changes = useMemo(() => changesByAgent(shares), [shares]);
  const rowFacts = useMemo(() => {
    const requests = new Map<string, Interaction>();
    for (const interaction of facts.interactions)
      if (!requests.has(interaction.agentId)) requests.set(interaction.agentId, interaction);
    const files = new Map(shares.map((share) => [share.agentId, share.files.map((f) => f.path)]));
    return { requests, files };
  }, [facts.interactions, shares]);
  const done = useMemo(
    () =>
      new Set(
        facts.agents
          .filter(
            (agent) =>
              agent.origin !== "root" &&
              agent.status.state === "idle" &&
              !facts.work.running.has(agent.id) &&
              !facts.work.needsYou.has(agent.id),
          )
          .map((agent) => agent.id),
      ),
    [facts.agents, facts.work],
  );
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
  const tasks = facts.tasks
    .filter((task) => task.status === "running" || task.status === "unknown")
    .map((task) => task.id);
  const queued = queuedInputLine({
    retained: page?.total ?? 0,
    queue: hold,
    status: thread.status,
    agentFailed: facts.agents.some(
      (agent) => agent.parentId === null && agent.status.state === "failed",
    ),
  });
  const background = tasks.length > 0 || queued !== undefined;
  const shown = summarySections({
    needsYou: needs.length,
    turn: turn !== undefined,
    plans,
    subagents: tree.some((node) => node.children.length > 0),
    agentsLive: facts.work.running.size > 0 || facts.work.needsYou.size > 0,
    background,
    changingAgents: changes.worktrees.reduce((sum, group) => sum + group.agents.length, 0),
    checks: checks.length,
    catchUp: catchUp.catchUp !== undefined,
    automations: automations.failed || !!automations.entries?.length,
  });
  return (
    <div
      ref={scroll}
      data-summary
      data-work-scroll
      className="flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto overscroll-contain px-1.5 py-1.5"
    >
      {shown.needsYou && (
        <Section name="Needs you" labelled={shown.labelled}>
          <NeedsYouList threadId={props.scope} items={needs} subagents={subagents} />
        </Section>
      )}
      {shown.turn && turn && (
        <Section name="This turn" labelled={shown.labelled}>
          <ThisTurn threadId={props.scope} turn={turn} />
        </Section>
      )}
      {shown.plans && (
        <Section name="Tasks" labelled={shown.labelled}>
          <WorkPlans threadId={props.scope} />
        </Section>
      )}
      {shown.agents && (
        <TreeWorkContext value={facts.work}>
          <Section
            name="Agents"
            labelled={shown.labelled}
            aside={<AgentCounts agents={facts.agents} work={facts.work} />}
          >
            {tree.length > 0 && (
              <WorkTree threadId={props.scope} nodes={tree} done={done} facts={rowFacts} />
            )}
            {background && (
              // Background commands are rows of the same kind, listed after the agents.
              <section aria-label="Background" className="min-w-0">
                <BackgroundList threadId={props.scope} taskIds={tasks} queued={queued} />
              </section>
            )}
          </Section>
        </TreeWorkContext>
      )}
      {shown.changes && (
        <Section name="Changes by agent" labelled={shown.labelled}>
          <AgentChanges threadId={props.scope} changes={changes} names={names} />
        </Section>
      )}
      {shown.checks && (
        <Section name="Checks" labelled={shown.labelled}>
          <Checks threadId={props.scope} checks={checks} />
        </Section>
      )}
      {shown.catchUp && catchUp.catchUp && (
        <Section name="Since you last looked" labelled={shown.labelled}>
          <CatchUp catchUp={catchUp.catchUp} onDismiss={catchUp.dismiss} />
        </Section>
      )}
      <WorkAutomations automations={automations} onClose={() => {}} />
    </div>
  );
}

/** A section of the summary: a small muted label, when there is more than one, over its rows. */
function Section(props: {
  name: string;
  labelled: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={props.name} className="min-w-0">
      {(props.labelled || props.aside) && (
        <div className="flex h-7 min-w-0 items-center gap-2 px-2 empty:hidden">
          {props.labelled && <h3 className="text-xs text-muted-foreground">{props.name}</h3>}
          {props.aside}
        </div>
      )}
      {props.children}
    </section>
  );
}

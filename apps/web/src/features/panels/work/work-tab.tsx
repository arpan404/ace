import { useCallback, type ReactNode } from "react";
import { useAgentTree, useThreadMeta } from "@ace/client-react";
import type { TurnActivity } from "@ace/ui-core";
import { useProjectAutomations, WorkAutomations } from "@/features/automations/index.ts";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { useShownPlans } from "@/lib/use-plans.ts";
import {
  attachWorkspaceScroll,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { BackgroundList } from "../agents/background-list.tsx";
import { useThreadParts } from "../agents/thread-parts.ts";
import { AgentCounts } from "../agents/tree-extras.tsx";
import { TreeWorkContext } from "../agents/tree-work-context.ts";
import { useTreeWork } from "../agents/use-tree-work.ts";
import { WorkTree } from "../agents/work-tree.tsx";
import { SummaryHead } from "./summary-head.tsx";
import { summarySections } from "./summary-sections.ts";
import { WorkPlans } from "./work-plans.tsx";

/** Outside a thread screen there is no live line to read. */
function NoActivity(props: { children(activity: TurnActivity | undefined): ReactNode }) {
  return props.children(undefined);
}

/**
 * The thread at a glance: one head line for where it stands, then only what is there, as plain
 * rows: its plan, its agent tree, the background commands and queued input still pending, and
 * the project's schedules. Small labels part the sections only when there is more than one.
 * Its checkout and git actions live in the header's thread details card.
 */
export default function WorkTab(props: TabViewProps) {
  const thread = useThreadMeta(props.scope);
  const actions = useWorkspaceActions(props.scope);
  const parts = useThreadParts();
  const Activity = parts.turnActivity ?? NoActivity;
  const facts = useTreeWork(props.scope);
  const tree = useAgentTree(props.scope) ?? [];
  const queued = useServerQueue(props.scope).page?.total ?? 0;
  const plans = useShownPlans(props.scope).length;
  const automations = useProjectAutomations(
    thread?.workspaceId ?? "",
    thread?.details?.workspace?.path,
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
  const queueWaiting = thread.status.state === "waiting" && thread.status.on === "queue";
  const shown = summarySections({
    plans,
    subagents: tree.some((node) => node.children.length > 0),
    agentsLive: facts.work.running.size > 0 || facts.work.needsYou.size > 0,
    background: tasks.length > 0 || queued > 0 || queueWaiting,
    automations: automations.failed || !!automations.entries?.length,
  });
  return (
    <div
      ref={scroll}
      data-work-scroll
      className="flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto overscroll-contain px-1.5 py-1.5"
    >
      <Activity threadId={props.scope}>
        {(activity) => (
          <SummaryHead
            activity={activity}
            background={tasks.length}
            thread={thread}
            showRequest={parts.showRequest}
          />
        )}
      </Activity>
      {shown.plans && (
        <Section name="Plan" labelled={shown.labelled}>
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
            <WorkTree threadId={props.scope} nodes={tree} />
          </Section>
        </TreeWorkContext>
      )}
      {shown.background && (
        <Section name="Background" labelled={shown.labelled}>
          <BackgroundList
            threadId={props.scope}
            taskIds={tasks}
            queued={queued}
            queueWaiting={queueWaiting}
          />
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

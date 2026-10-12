import { useCallback } from "react";
import { useThreadMeta } from "@ace/client-react";
import { WorkAutomations } from "@/features/automations/index.ts";
import {
  attachWorkspaceScroll,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { WorkTree } from "../agents/work-tree.tsx";
import { WorkPlans } from "./work-plans.tsx";

/**
 * The thread's plans, whole agent tree and project schedules. Its checkout and git actions live
 * in the header's thread details card.
 */
export default function WorkTab(props: TabViewProps) {
  const thread = useThreadMeta(props.scope);
  const actions = useWorkspaceActions(props.scope);
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
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Reading work…
      </p>
    );
  return (
    <div
      ref={scroll}
      data-work-scroll
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain"
    >
      <WorkPlans threadId={props.scope} />
      <section aria-label="Agents" className="min-w-0 px-1.5 py-1.5">
        <h2 className="flex h-7 items-center px-2.5 text-xs text-muted-foreground">Agents</h2>
        <WorkTree threadId={props.scope} />
      </section>
      <div className="px-1.5">
        <WorkAutomations
          workspaceId={thread.workspaceId}
          workspacePath={thread.details?.workspace?.path}
          onClose={() => {}}
        />
      </div>
    </div>
  );
}

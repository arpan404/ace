import { useCallback, Suspense } from "react";
import { useThreadMeta } from "@ace/client-react";
import { WorkAutomations } from "@/features/automations/index.ts";
import {
  attachWorkspaceScroll,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { useThreadParts } from "../agents/thread-parts.ts";
import { WorkTree } from "../agents/work-tree.tsx";
import { WorkPlans } from "./work-plans.tsx";

/** One home for the thread's checkout, whole agent tree and project schedules. */
export default function WorkTab(props: TabViewProps) {
  const thread = useThreadMeta(props.scope);
  const { WorkEnvironment: Environment } = useThreadParts();
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
      <div className="divide-y divide-border">
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">
              Reading environment…
            </p>
          }
        >
          {Environment && <Environment threadId={props.scope} />}
        </Suspense>
        <WorkPlans threadId={props.scope} />
        <section aria-label="Agents" className="min-w-0 py-3">
          <h2 className="px-5 text-xs font-medium text-muted-foreground">Agents</h2>
          <WorkTree threadId={props.scope} />
        </section>
        <div className="px-3">
          <WorkAutomations
            workspaceId={thread.workspaceId}
            workspacePath={thread.details?.workspace?.path}
            onClose={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

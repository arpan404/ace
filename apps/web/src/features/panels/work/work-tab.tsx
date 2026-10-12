import { lazy, Suspense } from "react";
import { useThreadMeta } from "@ace/client-react";
import { loadWorkEnvironment } from "@/features/thread/index.ts";
import { WorkAutomations } from "@/features/automations/index.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { AgentsTab } from "../agents/agents-tab.tsx";

const Environment = lazy(() => loadWorkEnvironment().then((m) => ({ default: m.WorkEnvironment })));

/** One home for the thread's checkout, whole agent tree and project schedules. */
export default function WorkTab(props: TabViewProps) {
  const thread = useThreadMeta(props.scope);
  if (!thread)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Reading work…
      </p>
    );
  return (
    <div aria-label="Work" className="divide-y divide-border">
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Reading environment…
          </p>
        }
      >
        <Environment
          thread={{
            id: props.scope,
            workspaceId: thread.workspaceId,
            title: thread.title,
            provider: thread.provider,
          }}
        />
      </Suspense>
      <section aria-label="Agents" className="min-w-0 py-3">
        <h2 className="px-5 text-xs font-medium text-muted-foreground">Agents</h2>
        <AgentsTab threadId={props.scope} />
      </section>
      <div className="px-3">
        <WorkAutomations
          workspaceId={thread.workspaceId}
          workspacePath={thread.details?.workspace?.path}
          onClose={() => {}}
        />
      </div>
    </div>
  );
}

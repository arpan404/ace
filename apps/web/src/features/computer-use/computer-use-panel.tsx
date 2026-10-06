import { Link } from "@tanstack/react-router";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { ApprovedApps, EnableRow, LiveSessions, StopAllButton } from "./sections.tsx";
import { useComputerUse } from "./use-computer-use.ts";

/**
 * Computer use beside a thread: every live session (this thread's first) with Take over,
 * Delegate to this thread's agents and Stop, and the apps this thread's agents may use.
 */
export default function ComputerUsePanel(props: TabViewProps) {
  const threadId = props.scope;
  const use = useComputerUse();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-3 pt-1 pb-6">
      <EnableRow use={use} />
      <section aria-label="Live sessions" className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-xs font-medium text-subtle-foreground">
            Live sessions
          </h2>
          <StopAllButton use={use} />
        </div>
        <LiveSessions use={use} threadId={threadId} narrow />
      </section>
      <section aria-label="Approved for this thread" className="mt-6">
        <h2 className="mb-1 text-xs font-medium text-subtle-foreground">
          Approved for this thread
        </h2>
        <ApprovedApps use={use} threadId={threadId} />
      </section>
      <p className="mt-6 text-xs text-subtle-foreground">
        Permissions and every app's grants are in{" "}
        <Link
          to="/settings/computer-use"
          className="text-link focus-ring rounded-xs hover:underline"
        >
          Settings › Computer use
        </Link>
        .
      </p>
    </div>
  );
}

import { Link } from "@tanstack/react-router";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { EnableRow, LiveSessions } from "./sections.tsx";
import { SharePicker } from "./share-picker.tsx";
import { useComputerUse } from "./use-computer-use.ts";

/**
 * Computer use beside a thread: every live session (this thread's first) with Take over,
 * Delegate to this thread's agents and Stop.
 */
export default function ComputerUsePanel(props: TabViewProps) {
  const threadId = props.scope;
  const use = useComputerUse();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-3 pt-1 pb-6">
      <EnableRow use={use} />
      {use.snapshot.enabled ? (
        <>
          <SharePicker use={use} threadId={threadId} />
          <section aria-label="Live sessions" className="mt-4">
            <h2 className="mb-2 text-xs font-medium text-subtle-foreground">Live sessions</h2>
            <LiveSessions use={use} threadId={threadId} narrow />
          </section>
          <p className="mt-6 text-xs text-subtle-foreground">
            Permissions are in{" "}
            <Link
              to="/settings/computer-use"
              className="text-link focus-ring rounded-xs hover:underline"
            >
              Settings › Computer use
            </Link>
            .
          </p>
        </>
      ) : (
        <p className="py-2 text-ui text-muted-foreground">Off · Turn on to let agents use apps.</p>
      )}
    </div>
  );
}

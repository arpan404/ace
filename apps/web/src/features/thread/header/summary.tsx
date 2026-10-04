import { ListBulletsIcon, XIcon } from "@phosphor-icons/react";
import { Suspense } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { DeferredSummaryBody } from "../deferred.ts";
import type { ThreadRef } from "../sources/index.ts";

/**
 * The header's summary toggle: pins a small card with the thread at a glance (its checkout, its
 * agents, background work) over the conversation's upper right. Kept per thread. The number of
 * opened tabs is the side panel toggle's, not this.
 */
export function SummaryToggle(props: { thread: ThreadRef }) {
  const pinned = useScopeWorkspace(props.thread.id).summaryPinned;
  const actions = useWorkspaceActions(props.thread.id);
  return (
    <IconButton
      icon={ListBulletsIcon}
      label={pinned ? "Hide thread summary" : "Show thread summary"}
      pressed={pinned}
      onClick={() => actions.setSummaryPinned(!pinned)}
    />
  );
}

/** The pinned summary card, while the toggle has it pinned. */
export function PinnedSummary(props: { thread: ThreadRef }) {
  const pinned = useScopeWorkspace(props.thread.id).summaryPinned;
  const actions = useWorkspaceActions(props.thread.id);
  if (!pinned) return null;
  return (
    <aside
      aria-label="Thread summary"
      className="glass fx-rise-in absolute top-3 right-4 z-[6] w-[288px] rounded-lg p-1.5 shadow-[var(--glass-shadow)]"
    >
      <div className="flex h-7 items-center justify-between pr-0.5 pl-2.5">
        <h2 className="text-xs font-medium text-subtle-foreground">Summary</h2>
        <IconButton
          icon={XIcon}
          label="Hide thread summary"
          size="sm"
          onClick={() => actions.setSummaryPinned(false)}
        />
      </div>
      <Suspense fallback={null}>
        <DeferredSummaryBody.Component thread={props.thread} />
      </Suspense>
    </aside>
  );
}

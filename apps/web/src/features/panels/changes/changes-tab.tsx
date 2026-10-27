import { usePanelServices } from "../services.ts";
import { ChangesToolbar } from "./changes-toolbar.tsx";
import { ReviewSurface } from "./review-surface.tsx";
import { useScopedDiff } from "@/lib/diffs/use-scoped-diff.ts";
import { useUncommitted } from "./working-tree-diff.tsx";

/**
 * Changes: a review surface for what the agents changed. Uncommitted shows the checkout's diff,
 * where lines take comments that go to the agent; a turn's scope shows that turn's edits, with
 * the review's comments listed read-only. Scope, layout and the files tree in the toolbar.
 */
export function ChangesTab(props: {
  threadId: string;
  path?: string | undefined;
  /** This Changes tab, whose scope and tree state it keeps; several can be open. */
  tabKey?: string | undefined;
}) {
  const { threadId } = props;
  const services = usePanelServices();
  const turn = useScopedDiff(threadId, props.tabKey);
  const { edited } = turn;
  const working = !edited.length || turn.scope === "working-tree";
  const uncommitted = useUncommitted(threadId, working);
  const files = working ? uncommitted.files : turn.files;
  // One surface whatever the scope, so what it holds (folded files) outlives a scope's change.
  return (
    <ReviewSurface
      threadId={threadId}
      tabKey={props.tabKey}
      path={props.path}
      label={working ? "Uncommitted diff" : undefined}
      files={files}
      versions={working ? uncommitted.versions : turn.versions}
      commentable={working}
      body={working ? uncommitted.body : undefined}
      toolbar={({ layout, prefs, views, refreshReview }) => (
        <ChangesToolbar
          threadId={threadId}
          scope={working ? "working-tree" : turn.scope}
          turns={edited}
          onScope={turn.setScope}
          stat={working ? uncommitted.stat : turn.stat}
          prefs={prefs}
          shown={layout.mode}
          splitTooNarrow={layout.splitTooNarrow}
          onPrefs={(change) => services.diffPrefs.set(change)}
          allCollapsed={views.allCollapsed}
          onCollapseAll={views.collapseAll}
          canShowTree={files.length > 1}
          onRefreshReview={refreshReview}
          {...(working
            ? {
                onRefresh: () => {
                  uncommitted.refresh();
                  refreshReview();
                },
                refreshing: uncommitted.refreshing,
              }
            : {})}
        />
      )}
      notice={
        working
          ? uncommitted.notice
          : turn.pending > 0 && (
              <p role="status" className="px-3.5 py-2 text-xs text-subtle-foreground">
                Preparing {turn.pending === 1 ? "1 file" : `${turn.pending} files`}…
              </p>
            )
      }
    />
  );
}

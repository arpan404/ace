import type { FileDiff, Turn } from "@ace/ui-core";
import { GitDiffIcon } from "@phosphor-icons/react";
import { memo, useMemo } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useWorkingTreeDiff } from "@/lib/diffs/use-working-tree.ts";
import { useElementWidth } from "@/lib/use-element-width.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { ChangesToolbar, type Scope } from "./changes-toolbar.tsx";
import { diffLayout } from "./diff-layout.ts";
import { DiffFiles, useDiffJump, useFileViews } from "./diff-files.tsx";
import { FileActions } from "./file-actions.tsx";
import { FileDiffBlock } from "./file-diff.tsx";
import type { FileView } from "./file-view.ts";

/**
 * Uncommitted changes, file by file in the same diff view as the agents' edits. Comments and
 * Viewed belong to a review of the agents' edits, so a checkout file has neither.
 */
export function WorkingTreeDiff(props: {
  threadId: string;
  tabKey?: string | undefined;
  /** A file to show once the diff is read (opened from a file's viewer). */
  path?: string | undefined;
  turns: readonly Turn[];
  onScope(scope: Scope): void;
}) {
  const services = usePanelServices();
  const { query: diff, files } = useWorkingTreeDiff(props.threadId);
  const stat = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  const prefs = useLocal(services.diffPrefs, identity);
  const [measure, width] = useElementWidth();
  const layout = diffLayout(width, prefs, files.length);
  const views = useFileViews(files);
  const jump = useDiffJump(files, views, props.path);
  const { setView } = views;
  const renderFile = (file: FileDiff, index: number) => (
    <CheckoutFile
      key={file.path}
      id={`${jump.anchor}-${index}`}
      threadId={props.threadId}
      file={file}
      view={views.viewOf(file)}
      mode={layout.mode}
      wrap={prefs.wrap}
      onView={setView}
    />
  );
  return (
    <div ref={measure} className="flex h-full min-h-0 flex-col">
      <ChangesToolbar
        threadId={props.threadId}
        scope="working-tree"
        turns={props.turns}
        onScope={props.onScope}
        stat={stat}
        prefs={prefs}
        shown={layout.mode}
        splitTooNarrow={layout.splitTooNarrow}
        onPrefs={(change) => services.diffPrefs.set(change)}
        allCollapsed={views.allCollapsed}
        onCollapseAll={views.collapseAll}
        canShowTree={files.length > 1}
        onRefresh={() => void diff.refetch()}
        refreshing={diff.isFetching}
      />
      {diff.isError ? (
        <EmptyState
          icon={GitDiffIcon}
          title="Couldn't read changes"
          description="Check that this thread has a git checkout, then refresh."
        />
      ) : diff.data ? (
        files.length ? (
          <section aria-label="Uncommitted diff" className="flex min-h-0 flex-1 flex-col">
            <DiffFiles
              threadId={props.threadId}
              tabKey={props.tabKey}
              files={files}
              layout={layout}
              jump={jump}
              viewOf={views.viewOf}
              notice={
                diff.data.truncated && (
                  <p role="status" className="px-3.5 py-2 text-xs text-subtle-foreground">
                    This diff is truncated at 256 KiB. The last file may be cut short.
                  </p>
                )
              }
              renderFile={renderFile}
            />
          </section>
        ) : (
          <EmptyState
            icon={GitDiffIcon}
            title="No uncommitted changes"
            description="The working tree matches HEAD."
            className="justify-start pt-6"
          />
        )
      ) : (
        <p role="status" className="p-3.5 text-sm text-muted-foreground">
          Reading changes…
        </p>
      )}
    </div>
  );
}

const identity = <T,>(value: T) => value;
const noHighlight = () => false;
const noAnnotation = () => null;

/** One uncommitted file: re-renders only when its own diff or view changes. */
const CheckoutFile = memo(function CheckoutFile(props: {
  id: string;
  threadId: string;
  file: FileDiff;
  view: FileView;
  mode: "unified" | "split";
  wrap: boolean;
  onView(path: string, view: FileView): void;
}) {
  const { file, view, onView } = props;
  return (
    <FileDiffBlock
      id={props.id}
      file={file}
      view={view}
      onView={(next) => onView(file.path, next)}
      mode={props.mode}
      wrap={props.wrap}
      highlighted={noHighlight}
      renderAnnotation={noAnnotation}
      actions={
        <FileActions
          threadId={props.threadId}
          path={file.path}
          open={view.open}
          onOpen={(open) => onView(file.path, { ...view, open })}
        />
      }
    />
  );
});

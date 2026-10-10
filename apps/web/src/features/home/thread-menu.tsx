import type { ForkPoint, ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import { Suspense, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import {
  ThreadActionItems,
  useHomeSelection,
  useSelected,
  useThreadActions,
} from "@/features/organize/index.ts";
import { PrLinksDialog, ForkDialog, useLatestForkPoint } from "@/features/thread/index.ts";
import { GitPullRequestIcon, LinkBreakIcon } from "@phosphor-icons/react";
import { MenuItem } from "@/components/ui/menu.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** A picked row's menu acts on every picked thread; its code comes with the selection bar's. */
const BulkMenuItems = deferredComponent(() =>
  import("./bulk-bar.tsx").then((module) => module.BulkMenuItems),
);

/** The items, mounted only while the menu is open: that is when the fork point is read. */
function RowItems(props: {
  entry: ThreadListEntry;
  state: ThreadRowFlags;
  onRename(): void;
  onPr(kind: "link" | "unlink"): void;
  onFork(point: ForkPoint): void;
}) {
  const point = useLatestForkPoint(props.entry.id);
  return (
    <ThreadActionItems
      entry={props.entry}
      flags={props.state}
      onRename={props.onRename}
      fork={{ point, onFork: props.onFork }}
      extra={
        <>
          <MenuItem
            icon={<GitPullRequestIcon aria-hidden size={16} />}
            onClick={() => props.onPr("link")}
          >
            Link pull request…
          </MenuItem>
          {(props.entry.details?.linkedPrs?.length || props.entry.details?.linkedPr) && (
            <MenuItem
              icon={<LinkBreakIcon aria-hidden size={16} />}
              onClick={() => props.onPr("unlink")}
            >
              Unlink all pull requests
            </MenuItem>
          )}
        </>
      }
      hints
    />
  );
}

/**
 * Right-click menu for a thread row: the same actions as the thread's ⋯ menu. R renames, P pins
 * or unpins and ⇧N starts a thread on main while it is open, as the hints say. On a row picked
 * with others it offers the bulk actions for all of them instead.
 */
export function ThreadMenu(props: {
  entry: ThreadListEntry;
  state: ThreadRowFlags;
  onRename(): void;
  children: ReactElement;
}) {
  const { entry } = props;
  const actions = useThreadActions();
  const selection = useHomeSelection();
  const selected = useSelected(entry.id);
  const [open, setOpen] = useState(false);
  // Read as the menu opens: a picked row among others speaks for all of them.
  const bulk = open && selected && selection.getState().ids.length > 1;
  const [prDialog, setPrDialog] = useState<"link" | "unlink">();
  const [forking, setForking] = useState<ForkPoint>();
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (bulk) return;
    if (event.key === "r" && !event.shiftKey) run(props.onRename)();
    else if (event.key === "p" && !event.shiftKey)
      run(() => actions.setPinned(entry, !props.state.pinned))();
    else if (event.key === "N" && event.shiftKey) run(() => actions.newThreadOnMain(entry))();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger data-row-menu-open={open ? "" : undefined} render={props.children} />
        <ContextMenuContent
          aria-label={bulk ? "Actions for the selected threads" : `Actions for ${entry.title}`}
          onKeyDownCapture={onKeyDown}
        >
          {bulk ? (
            <Suspense fallback={null}>
              <BulkMenuItems.Component />
            </Suspense>
          ) : (
            <RowItems
              entry={entry}
              state={props.state}
              onRename={props.onRename}
              onFork={setForking}
              onPr={setPrDialog}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>
      {prDialog && (
        <PrLinksDialog thread={entry} kind={prDialog} onClose={() => setPrDialog(undefined)} />
      )}
      {forking && (
        <ForkDialog thread={entry} point={forking} onClose={() => setForking(undefined)} />
      )}
    </>
  );
}

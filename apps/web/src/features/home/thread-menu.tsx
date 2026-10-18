import type { ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import { Suspense, useState } from "react";
import type { ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { useHomeSelection, useSelected } from "@/features/organize/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { RowItems, useRowDialogs } from "./row-menu-items.tsx";
import { useRowMenuShortcuts } from "./use-row-menu-shortcuts.ts";

/** A picked row's menu acts on every picked thread; its code comes with the selection bar's. */
const BulkMenuItems = deferredComponent(() =>
  import("./bulk-bar.tsx").then((module) => module.BulkMenuItems),
);

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
  const selection = useHomeSelection();
  const selected = useSelected(entry.id);
  const [open, setOpen] = useState(false);
  // Read as the menu opens: a picked row among others speaks for all of them.
  const bulk = open && selected && selection.getState().ids.length > 1;
  const dialogs = useRowDialogs(entry);
  const onKeyDown = useRowMenuShortcuts({
    entry,
    flags: props.state,
    onRename: props.onRename,
    onClose: () => setOpen(false),
  });
  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger data-row-menu-open={open ? "" : undefined} render={props.children} />
        <ContextMenuContent
          aria-label={bulk ? "Actions for the selected threads" : `Actions for ${entry.title}`}
          onKeyDownCapture={bulk ? undefined : onKeyDown}
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
              onFork={dialogs.onFork}
              onPr={dialogs.onPr}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>
      {dialogs.dialogs}
    </>
  );
}

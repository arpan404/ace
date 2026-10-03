import type { ForkPoint, ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import { useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { ThreadActionItems, useThreadActions } from "@/features/organize/index.ts";
import { ForkDialog, useLatestForkPoint } from "@/features/thread/index.ts";

/** The items, mounted only while the menu is open: that is when the fork point is read. */
function RowItems(props: {
  entry: ThreadListEntry;
  state: ThreadRowFlags;
  onRename(): void;
  onFork(point: ForkPoint): void;
}) {
  const point = useLatestForkPoint(props.entry.id);
  return (
    <ThreadActionItems
      entry={props.entry}
      flags={props.state}
      onRename={props.onRename}
      fork={{ point, onFork: props.onFork }}
      hints
    />
  );
}

/**
 * Right-click menu for a thread row: the same actions as the thread's ⋯ menu. R renames and
 * ⇧N starts a thread on main while it is open, as the hints say.
 */
export function ThreadMenu(props: {
  entry: ThreadListEntry;
  state: ThreadRowFlags;
  onRename(): void;
  children: ReactElement;
}) {
  const { entry } = props;
  const actions = useThreadActions();
  const [open, setOpen] = useState(false);
  const [forking, setForking] = useState<ForkPoint>();
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "r" && !event.shiftKey) run(props.onRename)();
    else if (event.key === "N" && event.shiftKey) run(() => actions.newThreadOnMain(entry))();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger render={props.children} />
        <ContextMenuContent aria-label={`Actions for ${entry.title}`} onKeyDownCapture={onKeyDown}>
          <RowItems
            entry={entry}
            state={props.state}
            onRename={props.onRename}
            onFork={setForking}
          />
        </ContextMenuContent>
      </ContextMenu>
      {forking && (
        <ForkDialog thread={entry} point={forking} onClose={() => setForking(undefined)} />
      )}
    </>
  );
}

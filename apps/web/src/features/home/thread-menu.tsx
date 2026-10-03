import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CheckIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  MoonIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { Icon } from "@/components/icon.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { SnoozeItems } from "./snooze-items.tsx";
import { useThreadActions } from "./use-thread-actions.ts";

export interface RowState {
  settled: boolean;
  unread: boolean;
  pinned: boolean;
  snoozed: boolean;
}

/**
 * Right-click menu for a thread row. R renames and ⇧N starts a thread on main while it is
 * open, as the hints say.
 */
export function ThreadMenu(props: {
  entry: ThreadListEntry;
  state: RowState;
  onRename(): void;
  children: ReactElement;
}) {
  const { entry, state } = props;
  const actions = useThreadActions();
  const [open, setOpen] = useState(false);
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
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger render={props.children} />
      <ContextMenuContent aria-label={`Actions for ${entry.title}`} onKeyDownCapture={onKeyDown}>
        <MenuItem
          icon={<Icon icon={NotePencilIcon} />}
          keys="shift+n"
          onClick={() => actions.newThreadOnMain(entry)}
        >
          New thread on main
        </MenuItem>
        <MenuItem icon={<Icon icon={PencilSimpleIcon} />} keys="r" onClick={props.onRename}>
          Rename
        </MenuItem>
        <MenuItem
          icon={<Icon icon={state.unread ? EnvelopeSimpleOpenIcon : EnvelopeSimpleIcon} />}
          onClick={() => actions.setUnread(entry, !state.unread)}
        >
          {state.unread ? "Mark read" : "Mark unread"}
        </MenuItem>
        <MenuItem
          icon={<Icon icon={state.pinned ? PushPinSlashIcon : PushPinIcon} />}
          onClick={() => actions.setPinned(entry, !state.pinned)}
        >
          {state.pinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger icon={<Icon icon={MoonIcon} />}>Snooze</MenuSubTrigger>
          <MenuContent side="right" align="start" sideOffset={4}>
            <SnoozeItems entry={entry} actions={actions} snoozed={state.snoozed} />
          </MenuContent>
        </MenuSub>
        {state.settled ? (
          <MenuItem
            icon={<Icon icon={ArrowCounterClockwiseIcon} />}
            onClick={() => actions.unsettle(entry)}
          >
            Unsettle
          </MenuItem>
        ) : (
          <MenuItem icon={<Icon icon={CheckIcon} />} onClick={() => actions.settle(entry)}>
            Settle
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<Icon icon={ArchiveIcon} />} onClick={() => actions.archive(entry)}>
          Archive
        </MenuItem>
        <MenuItem danger icon={<Icon icon={TrashIcon} />} onClick={() => actions.remove(entry)}>
          Delete thread
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

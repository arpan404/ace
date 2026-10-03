import type { ForkPoint, ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CheckIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  GitForkIcon,
  LinkIcon,
  MoonIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { SnoozeItems } from "./snooze-items.tsx";
import { useThreadActions } from "./use-thread-actions.ts";

/**
 * Everything a person can do to one thread, in one order, for the Home row's context menu and
 * the thread's ⋯ menu alike: start another, rename, fork, link; read and pin; snooze and
 * settle; archive and delete (with Undo). `hints` shows the R and ⇧N keys the context menu binds;
 * `extra` adds the caller's own items after the link; `onLeave` runs once the thread is gone
 * from the list (archived or deleted), so the open thread can step back to Home.
 */
export function ThreadActionItems(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  fork: { point: ForkPoint | undefined; onFork(point: ForkPoint): void };
  hints?: boolean;
  extra?: ReactNode;
  onLeave?(): void;
}) {
  const { entry, flags, fork } = props;
  const actions = useThreadActions();
  return (
    <>
      <MenuItem
        icon={<Icon icon={NotePencilIcon} />}
        {...(props.hints ? { keys: "shift+n" } : {})}
        onClick={() => actions.newThreadOnMain(entry)}
      >
        New thread on main
      </MenuItem>
      <MenuItem
        icon={<Icon icon={PencilSimpleIcon} />}
        {...(props.hints ? { keys: "r" } : {})}
        onClick={props.onRename}
      >
        Rename
      </MenuItem>
      <MenuItem
        icon={<Icon icon={GitForkIcon} />}
        disabled={!fork.point}
        reason={fork.point ? undefined : "Available after the first turn finishes"}
        onClick={() => fork.point && fork.onFork(fork.point)}
      >
        Fork from the last turn…
      </MenuItem>
      <MenuItem icon={<Icon icon={LinkIcon} />} onClick={() => actions.copyLink(entry)}>
        Copy link
      </MenuItem>
      {props.extra}
      <MenuSeparator />
      <MenuItem
        icon={<Icon icon={flags.unread ? EnvelopeSimpleOpenIcon : EnvelopeSimpleIcon} />}
        onClick={() => actions.setUnread(entry, !flags.unread)}
      >
        {flags.unread ? "Mark read" : "Mark unread"}
      </MenuItem>
      <MenuItem
        icon={<Icon icon={flags.pinned ? PushPinSlashIcon : PushPinIcon} />}
        onClick={() => actions.setPinned(entry, !flags.pinned)}
      >
        {flags.pinned ? "Unpin" : "Pin"}
      </MenuItem>
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger icon={<Icon icon={MoonIcon} />}>Snooze</MenuSubTrigger>
        <MenuContent side="right" align="start" sideOffset={4}>
          <SnoozeItems entry={entry} actions={actions} snoozed={flags.snoozed} />
        </MenuContent>
      </MenuSub>
      {flags.settled ? (
        <MenuItem
          icon={<Icon icon={ArrowCounterClockwiseIcon} />}
          onClick={() => actions.unsettle(entry)}
        >
          Unsettle
        </MenuItem>
      ) : (
        // The daemon settles only finished work.
        entry.status.state === "done" && (
          <MenuItem icon={<Icon icon={CheckIcon} />} onClick={() => actions.settle(entry)}>
            Settle
          </MenuItem>
        )
      )}
      <MenuSeparator />
      <MenuItem
        icon={<Icon icon={ArchiveIcon} />}
        onClick={() => {
          actions.archive(entry);
          props.onLeave?.();
        }}
      >
        Archive
      </MenuItem>
      <MenuItem
        danger
        icon={<Icon icon={TrashIcon} />}
        onClick={() => {
          actions.remove(entry);
          props.onLeave?.();
        }}
      >
        Delete thread
      </MenuItem>
    </>
  );
}

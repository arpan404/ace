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
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";
import {
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { SnoozeItems } from "./snooze-items.tsx";
import { useThreadActions, type ThreadActions } from "./use-thread-actions.ts";

/**
 * One thing a person can do to a thread: what the ⋯ menu, the row's context menu and the
 * palette all draw from, so they never drift apart.
 */
export interface ThreadAction {
  id: string;
  label: string;
  icon: IconGlyph;
  /** The open thread's own shortcut for it, where there is one. */
  shortcut?: KeymapId;
  danger?: boolean;
  /** Why it can't be done yet; the action shows, dimmed, with this beside it. */
  disabled?: string;
  /** The block it belongs to: blocks are separated in menus. */
  section: "start" | "read" | "settle" | "leave";
  run(): void;
}

/**
 * Every action on one thread, in menu order: start another, rename, fork, link; read and pin;
 * settle; archive with Undo and permanent delete. Snooze, a submenu of times, is the menus' own.
 * `onLeave` runs once the thread is gone from the list (archived or deleted).
 */
export function threadActions(
  entry: ThreadListEntry,
  flags: ThreadRowFlags,
  actions: ThreadActions,
  handlers: {
    onRename(): void;
    fork: { point: ForkPoint | undefined; onFork(point: ForkPoint): void };
    onLeave?(): void;
  },
): ThreadAction[] {
  const { fork } = handlers;
  const list: ThreadAction[] = [
    {
      id: "new-on-main",
      label: "New thread on main",
      icon: NotePencilIcon,
      section: "start",
      run: () => actions.newThreadOnMain(entry),
    },
    {
      id: "rename",
      label: "Rename",
      icon: PencilSimpleIcon,
      shortcut: "renameThread",
      section: "start",
      run: handlers.onRename,
    },
    {
      id: "fork",
      label: "Fork from the last turn…",
      icon: GitForkIcon,
      section: "start",
      ...(fork.point ? {} : { disabled: "Available after the first turn finishes" }),
      run: () => fork.point && fork.onFork(fork.point),
    },
    {
      id: "copy-link",
      label: "Copy link",
      icon: LinkIcon,
      section: "start",
      run: () => actions.copyLink(entry),
    },
    {
      id: "unread",
      label: flags.unread ? "Mark read" : "Mark unread",
      icon: flags.unread ? EnvelopeSimpleOpenIcon : EnvelopeSimpleIcon,
      section: "read",
      run: () => actions.setUnread(entry, !flags.unread),
    },
    {
      id: "pin",
      label: flags.pinned ? "Unpin" : "Pin",
      icon: flags.pinned ? PushPinSlashIcon : PushPinIcon,
      shortcut: "pinThread",
      section: "read",
      run: () => actions.setPinned(entry, !flags.pinned),
    },
  ];
  if (flags.settled)
    list.push({
      id: "unsettle",
      label: "Unsettle",
      icon: ArrowCounterClockwiseIcon,
      section: "settle",
      run: () => actions.unsettle(entry),
    });
  // The daemon settles only finished work.
  else if (entry.status.state === "done")
    list.push({
      id: "settle",
      label: "Settle",
      icon: CheckIcon,
      section: "settle",
      run: () => actions.settle(entry),
    });
  list.push(
    {
      id: "archive",
      label: "Archive",
      icon: ArchiveIcon,
      shortcut: "archiveThread",
      section: "leave",
      run: () => {
        actions.archive(entry);
        handlers.onLeave?.();
      },
    },
    {
      id: "delete",
      label: "Delete thread",
      icon: TrashIcon,
      danger: true,
      section: "leave",
      run: () => {
        actions.remove(entry);
        handlers.onLeave?.();
      },
    },
  );
  return list;
}

/** The context menu's single-key hints, where the Home row binds them. */
const rowHints: Partial<Record<string, string>> = {
  "new-on-main": "shift+n",
  rename: "r",
  pin: "p",
};

/**
 * Everything a person can do to one thread, for the Home row's context menu and the thread's ⋯
 * menu alike (`threadActions`), with Snooze before settling. `hints` shows the R, P and ⇧N keys
 * the context menu binds; `shortcuts` the open thread's own (⌥⌘R, ⌥⌘P, ⇧⌘A), where they act;
 * `extra` adds the caller's own items after the link.
 */
export function ThreadActionItems(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  fork: { point: ForkPoint | undefined; onFork(point: ForkPoint): void };
  hints?: boolean;
  /** The open thread's own shortcuts (⌥⌘R, ⌥⌘P, ⇧⌘A), shown where they act: its ⋯ menu. */
  shortcuts?: boolean;
  extra?: ReactNode;
  onLeave?(): void;
}) {
  const { entry, flags } = props;
  const actions = useThreadActions();
  const list = threadActions(entry, flags, actions, {
    onRename: props.onRename,
    fork: props.fork,
    ...(props.onLeave ? { onLeave: props.onLeave } : {}),
  });
  const item = (action: ThreadAction) => {
    const hint = props.hints ? rowHints[action.id] : undefined;
    return (
      <MenuItem
        key={action.id}
        icon={<Icon icon={action.icon} />}
        {...(hint
          ? { keys: hint }
          : props.shortcuts && action.shortcut
            ? { shortcut: action.shortcut }
            : {})}
        {...(action.danger ? { danger: true } : {})}
        disabled={action.disabled !== undefined}
        reason={action.disabled}
        onClick={action.run}
      >
        {action.label}
      </MenuItem>
    );
  };
  const section = (name: ThreadAction["section"]) =>
    list.filter((action) => action.section === name).map(item);
  return (
    <>
      {section("start")}
      {props.extra}
      <MenuSeparator />
      {section("read")}
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger icon={<Icon icon={MoonIcon} />}>Snooze</MenuSubTrigger>
        <MenuContent side="right" align="start" sideOffset={4}>
          <SnoozeItems entry={entry} actions={actions} snoozed={flags.snoozed} />
        </MenuContent>
      </MenuSub>
      {section("settle")}
      <MenuSeparator />
      {section("leave")}
    </>
  );
}

import { continueBlocked } from "@ace/client";
import type { ForkPoint, ThreadListEntry } from "@ace/protocol";
import {
  autoSettleChoice,
  settleChoice,
  threadMenu,
  threadMenuDanger,
  threadMenuLabels,
  threadMenuSection,
  type ThreadMenuId,
  type ThreadRowFlags,
} from "@ace/ui-core";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CheckIcon,
  ClockCountdownIcon,
  DesktopIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  FolderSimpleIcon,
  GitForkIcon,
  LinkIcon,
  MoonIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TimerIcon,
  TrashIcon,
  TrayArrowUpIcon,
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
import { useThreadMover } from "./mover.ts";
import { useTransferOpener } from "@/lib/transfer-opener.ts";
import { useHasLinkedMachines } from "@/lib/fleet-links.ts";
import { useScopedMachine } from "@/lib/machines.ts";
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
 * Every action on one thread, in menu order: start another, rename, fork, link; read, pin and
 * move to another project; settle; archive with Undo (or, archived, restore) and permanent
 * delete. Snooze, a submenu of times, is the menus' own. `onLeave` handles leaving an archived
 * thread; deletion navigates only after confirmation in the shared action owner.
 */
export function threadActions(
  entry: ThreadListEntry,
  flags: ThreadRowFlags,
  actions: ThreadActions,
  handlers: {
    onRename(): void;
    fork: { point: ForkPoint | undefined; onFork(point: ForkPoint): void };
    /** Ask which project it moves to. */
    onMove(): void;
    /** Ask which machine it continues on (ADR 0101). */
    onContinueOn?(): void;
    onLeave?(): void;
  },
): ThreadAction[] {
  const { fork } = handlers;
  const item = (id: ThreadMenuId): ThreadAction => {
    // Read and Unpin keep the ids of the toggles they are, as the compact menu lists them.
    const key = id === "read" ? "unread" : id === "unpin" ? "pin" : id;
    const base = { id: key, label: threadMenuLabels[id], section: threadMenuSection(id) };
    switch (id) {
      case "new-on-main":
        return { ...base, icon: NotePencilIcon, run: () => actions.newThreadOnMain(entry) };
      case "rename":
        return {
          ...base,
          icon: PencilSimpleIcon,
          shortcut: "renameThread",
          run: handlers.onRename,
        };
      case "fork":
        return {
          ...base,
          icon: GitForkIcon,
          ...(fork.point ? {} : { disabled: "Available after the first turn finishes" }),
          run: () => fork.point && fork.onFork(fork.point),
        };
      case "copy-link":
        return { ...base, icon: LinkIcon, run: () => actions.copyLink(entry) };
      case "unread":
      case "read":
        return {
          ...base,
          icon: id === "read" ? EnvelopeSimpleOpenIcon : EnvelopeSimpleIcon,
          run: () => actions.setUnread(entry, id === "unread"),
        };
      case "pin":
      case "unpin":
        return {
          ...base,
          icon: id === "unpin" ? PushPinSlashIcon : PushPinIcon,
          shortcut: "pinThread",
          run: () => actions.setPinned(entry, id === "pin"),
        };
      case "move":
        return { ...base, icon: FolderSimpleIcon, run: handlers.onMove };
      case "settle":
      case "unsettle":
        return settleItem(entry, id, actions);
      case "auto-settle-off":
      case "auto-settle-on":
        return autoSettleItem(entry, id, actions);
      case "archive":
        return {
          ...base,
          icon: ArchiveIcon,
          shortcut: "archiveThread",
          run: () => actions.archive(entry, handlers.onLeave),
        };
      case "restore":
        return { ...base, icon: TrayArrowUpIcon, run: () => actions.restore(entry) };
      case "delete":
        return {
          ...base,
          icon: TrashIcon,
          danger: threadMenuDanger(id),
          run: () => {
            actions.remove(entry);
          },
        };
    }
  };
  const list: ThreadAction[] = [];
  for (const id of threadMenu(entry, flags)) {
    list.push(item(id));
    // Continue on follows Move, where machines link (ADR 0101).
    if (id === "move" && handlers.onContinueOn)
      list.push({
        id: "continue-on",
        label: "Continue on…",
        icon: DesktopIcon,
        section: "read",
        ...(continueBlocked(entry.status.state)
          ? { disabled: "Available once the thread stops working" }
          : {}),
        run: handlers.onContinueOn,
      });
  }
  return list;
}

function settleItem(
  entry: ThreadListEntry,
  id: "settle" | "unsettle",
  actions: ThreadActions,
): ThreadAction {
  return {
    id,
    label: threadMenuLabels[id],
    icon: id === "unsettle" ? ArrowCounterClockwiseIcon : CheckIcon,
    section: "settle",
    run: () => (id === "unsettle" ? actions.unsettle(entry) : actions.settle(entry)),
  };
}

function autoSettleItem(
  entry: ThreadListEntry,
  id: "auto-settle-off" | "auto-settle-on",
  actions: ThreadActions,
): ThreadAction {
  return {
    id: "auto-settle",
    label: threadMenuLabels[id],
    icon: id === "auto-settle-off" ? TimerIcon : ClockCountdownIcon,
    section: "settle",
    run: () => actions.setAutoSettle(entry, id === "auto-settle-on"),
  };
}

/**
 * Settle any thread that is not working, or Unsettle a settled one; nothing while work
 * continues, since the daemon settles only non-working threads. The menus and the Home row's
 * hover action share it (`settleChoice`).
 */
export function settleAction(
  entry: ThreadListEntry,
  flags: ThreadRowFlags,
  actions: ThreadActions,
): ThreadAction | undefined {
  const choice = settleChoice(entry, flags);
  return choice && settleItem(entry, choice, actions);
}

/** Turn the thread's own auto-settle off (it stays until settled by hand) or back on. */
export function autoSettleAction(entry: ThreadListEntry, actions: ThreadActions): ThreadAction {
  return autoSettleItem(entry, autoSettleChoice(entry), actions);
}

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
  compact?: boolean;
}) {
  const { entry, flags } = props;
  const actions = useThreadActions();
  const mover = useThreadMover();
  const transfers = useTransferOpener();
  const linked = useHasLinkedMachines();
  // Another machine's thread (ADR 0102): every action runs on that machine's client, the picker
  // lists that machine's projects, and Continue on is sent from that machine.
  const scoped = useScopedMachine()?.id;
  const allActions = threadActions(entry, flags, actions, {
    onRename: props.onRename,
    fork: props.fork,
    onMove: () => mover.open({ entries: [entry], ...(scoped ? { hostId: scoped } : {}) }),
    ...(linked
      ? {
          onContinueOn: () =>
            transfers.open({
              kind: "thread",
              threadId: entry.id,
              workspaceId: entry.workspaceId,
              title: entry.title,
              ...(scoped ? { hostId: scoped } : {}),
            }),
        }
      : {}),
    ...(props.onLeave ? { onLeave: props.onLeave } : {}),
  });
  const list = props.compact
    ? allActions.filter((action) =>
        [
          "rename",
          "unread",
          "pin",
          "move",
          "continue-on",
          "auto-settle",
          "archive",
          "restore",
          "delete",
        ].includes(action.id),
      )
    : allActions.filter((action) => !action.disabled);
  const section = (name: ThreadAction["section"]) =>
    list.filter((action) => action.section === name).map(renderThreadAction);
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

function renderThreadAction(action: ThreadAction) {
  return (
    <MenuItem
      key={action.id}
      icon={<Icon icon={action.icon} />}
      {...(action.shortcut ? { shortcut: action.shortcut } : {})}
      {...(action.danger ? { danger: true } : {})}
      {...(action.disabled ? { disabled: true, reason: action.disabled } : {})}
      onClick={action.run}
    >
      {action.label}
    </MenuItem>
  );
}

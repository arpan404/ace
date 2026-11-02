import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import type { ThreadRowFlags } from "@ace/ui-core";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { threadActions, useThreadActions, useThreadMover } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { useScopedMachine } from "@/lib/machines.ts";
import { useRowMenuShortcuts } from "./use-row-menu-shortcuts.ts";

/** A chat's menu, in order: the thread menus' own Rename, Pin, Move and Delete. */
const shownIds: ReadonlySet<string> = new Set(["rename", "pin", "move", "delete"]);
const noFork = { point: undefined, onFork: () => {} };

/**
 * A chat row's hover and focus action: one ⋯ at its right edge, opening the thread menus'
 * own items for a chat (Rename, Pin or Unpin, Move to project, then Delete apart and
 * destructive, which asks first). The same menu components and item style as a thread row's
 * ⋯, so the rows stay alike; the rest stays in the row's context menu.
 */
export function ChatRowActions(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  onHover(): void;
  shown: boolean;
}) {
  const actions = useThreadActions();
  const mover = useThreadMover();
  const scoped = useScopedMachine()?.id;
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const onKeyDown = useRowMenuShortcuts({
    entry,
    flags: props.flags,
    onRename: props.onRename,
    onClose: () => setOpen(false),
  });
  const list = threadActions(entry, props.flags, actions, {
    onRename: props.onRename,
    fork: noFork,
    onMove: () => mover.open({ entries: [entry], ...(scoped ? { hostId: scoped } : {}) }),
  }).filter((action) => shownIds.has(action.id) && !action.disabled);
  // Delete stays apart and destructive, as in the thread rows' menus.
  const head = list.filter((action) => action.id !== "delete");
  const tail = list.filter((action) => action.id === "delete");
  return (
    <div
      // Centred on the row's one line, so the row never moves.
      className={cn(
        "absolute top-1/2 right-1.5 -translate-y-1/2 items-center",
        props.shown ? "flex" : "hidden has-[[data-popup-open]]:flex",
      )}
      role="presentation"
      onPointerEnter={props.onHover}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <IconButton
              icon={DotsThreeIcon}
              size="sm"
              label={`Actions for ${entry.title}`}
              tabIndex={-1}
            />
          }
        />
        <MenuContent align="end" onKeyDownCapture={onKeyDown}>
          {head.map((action) => (
            <MenuItem
              key={action.id}
              icon={<Icon icon={action.icon} />}
              {...(action.shortcut ? { shortcut: action.shortcut } : {})}
              onClick={action.run}
            >
              {action.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          {tail.map((action) => (
            <MenuItem
              key={action.id}
              icon={<Icon icon={action.icon} />}
              {...(action.danger ? { danger: true } : {})}
              onClick={action.run}
            >
              {action.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

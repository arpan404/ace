import { ClockIcon, DotsThreeIcon } from "@phosphor-icons/react";
import type { ThreadRowFlags } from "@ace/ui-core";
import type { ThreadListEntry } from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  settleAction,
  SnoozeItems,
  ThreadActionItems,
  useThreadActions,
} from "@/features/organize/index.ts";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { useState } from "react";
import { useRowMenuShortcuts } from "./use-row-menu-shortcuts.ts";

/**
 * The row's hover and focus actions, over its status in the top line: Snooze (a clock that opens
 * the snooze times), Settle or Unsettle where the thread allows it, and the ⋯ menu of everything
 * else. The same registry owns row and header menu entries.
 */
export function RowActions(props: {
  entry: ThreadListEntry;
  flags: ThreadRowFlags;
  onRename(): void;
  onHover(): void;
}) {
  const [open, setOpen] = useState(false);
  const onKeyDown = useRowMenuShortcuts({ ...props, onClose: () => setOpen(false) });
  const actions = useThreadActions();
  const settle = settleAction(props.entry, props.flags, actions);
  const title = props.entry.title;
  return (
    <div
      // Centred on the top line (12px padding, 16px line), so the row never moves.
      className="absolute top-5 right-1.5 hidden -translate-y-1/2 items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex has-[[data-popup-open]]:flex"
      onPointerEnter={props.onHover}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Menu>
        <MenuTrigger
          render={<IconButton icon={ClockIcon} size="sm" label={`Snooze ${title}`} tip="Snooze" />}
        />
        <MenuContent align="end">
          <SnoozeItems entry={props.entry} actions={actions} snoozed={props.flags.snoozed} />
        </MenuContent>
      </Menu>
      {settle && (
        <button
          type="button"
          aria-label={`${settle.label} ${title}`}
          onClick={settle.run}
          className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-accent hover:text-foreground"
        >
          <Icon icon={settle.icon} size={12} />
          {settle.label}
        </button>
      )}
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={<IconButton icon={DotsThreeIcon} size="sm" label={`Actions for ${title}`} />}
        />
        <MenuContent align="end" onKeyDownCapture={onKeyDown}>
          <ThreadActionItems
            entry={props.entry}
            flags={props.flags}
            onRename={props.onRename}
            fork={{ point: undefined, onFork: () => {} }}
          />
        </MenuContent>
      </Menu>
    </div>
  );
}

import { ArrowUUpLeftIcon, CheckIcon, MoonIcon } from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SnoozeItems, useThreadActions } from "@/features/organize/index.ts";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useRef, useState } from "react";

/** Quick Settle and Snooze actions; Pin remains in the task context menu. */
export function RowActions(props: { entry: ThreadListEntry; settled: boolean; snoozed: boolean }) {
  const actions = useThreadActions();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeTrigger = useRef<HTMLButtonElement>(null);
  const { entry, settled } = props;
  return (
    <div
      className={`absolute ${settled ? "top-0" : "top-1"} right-1 hidden items-center group-focus-within/row:flex group-hover/row:flex group-data-popup-open/row:invisible has-[[data-popup-open]]:flex`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={settled ? ArrowUUpLeftIcon : CheckIcon}
        size="sm"
        label={`${settled ? "Unsettle" : "Settle"} ${entry.title}`}
        tip={settled ? "Unsettle" : "Settle"}
        disabled={!settled && entry.status.state !== "done"}
        reason={
          !settled && entry.status.state !== "done" ? "Settle after the task finishes" : undefined
        }
        onClick={() => (settled ? actions.unsettle(entry) : actions.settle(entry))}
      />
      {!settled && (
        <Menu
          open={snoozeOpen}
          onOpenChange={(open, details) => {
            // The hover-only trigger must receive focus before its popup-open mark is removed.
            if (!open && details.reason === "escape-key") snoozeTrigger.current?.focus();
            setSnoozeOpen(open);
          }}
        >
          <Tip label="Snooze…" side="top" disabled={snoozeOpen}>
            <MenuTrigger
              render={
                <IconButton
                  ref={snoozeTrigger}
                  icon={MoonIcon}
                  size="sm"
                  label={`Snooze ${entry.title}`}
                  tooltip={false}
                />
              }
            />
          </Tip>
          <MenuContent align="end" className="min-w-[200px]">
            <SnoozeItems entry={entry} actions={actions} snoozed={props.snoozed} />
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

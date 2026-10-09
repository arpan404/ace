import { ArrowUUpLeftIcon, CheckIcon, MoonIcon } from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SnoozeItems, useThreadActions } from "@/features/organize/index.ts";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useRef, useState } from "react";

/** Quick Settle and Snooze actions; Pin remains in the task context menu. */
export function RowActions(props: {
  entry: ThreadListEntry;
  settled: boolean;
  snoozed: boolean;
  machinePrimary: boolean;
}) {
  const actions = useThreadActions();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeTrigger = useRef<HTMLButtonElement>(null);
  const { entry, settled } = props;
  const disabled = !settled && entry.status.state !== "done";
  const word = settled ? "Unsettle" : "Settle";
  const Glyph = settled ? ArrowUUpLeftIcon : CheckIcon;
  return (
    <div
      className={cn(
        "absolute hidden items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex group-data-row-menu-open/row:invisible has-[[data-popup-open]]:flex",
        settled ? (props.machinePrimary ? "top-0 right-8" : "top-0 right-14") : "top-1 right-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Tip label={disabled ? "Settle after the task finishes" : word}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${word} ${entry.title}`}
          disabled={disabled}
          focusableWhenDisabled={disabled}
          className="h-6 gap-1 px-1.5 text-xs text-subtle-foreground data-disabled:pointer-events-auto data-disabled:opacity-60"
          onClick={() => (settled ? actions.unsettle(entry) : actions.settle(entry))}
        >
          <Glyph aria-hidden size={14} />
          <span>{word}</span>
        </Button>
      </Tip>
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
                  className="text-subtle-foreground"
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

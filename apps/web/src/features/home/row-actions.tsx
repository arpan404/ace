import {
  ArrowsClockwiseIcon,
  CheckIcon,
  MoonIcon,
  PushPinIcon,
  PushPinSlashIcon,
} from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { SnoozeItems, useThreadActions } from "@/features/organize/index.ts";

/**
 * Settle (finished threads) and Snooze, or Unsettle on a settled row, then Pin or Unpin,
 * floating at the row's top right while the pointer or keyboard focus is on the row. Snooze and
 * Pin are icons, each named by its tooltip and its accessible label. They cover the age, which
 * hides meanwhile, and step aside while the row's context menu is open.
 */
export function RowActions(props: {
  entry: ThreadListEntry;
  settled: boolean;
  pinned: boolean;
  snoozed: boolean;
  className?: string;
}) {
  const actions = useThreadActions();
  const title = props.entry.title;
  return (
    <div
      className={cn(
        "fx-view-in absolute top-1.5 right-2 hidden gap-0.5 rounded-md bg-popover p-0.5 shadow-[0_1px_3px_rgb(0_0_0/0.18),var(--glass-highlight),0_0_0_0.5px_var(--border)] group-focus-within/row:flex group-hover/row:flex group-data-popup-open/row:invisible has-[[data-popup-open]]:flex",
        props.className,
      )}
    >
      {props.settled ? (
        <HoverButton
          icon={<Icon icon={ArrowsClockwiseIcon} size={14} />}
          aria-label={`Unsettle ${title}`}
          onClick={() => actions.unsettle(props.entry)}
        >
          Unsettle
        </HoverButton>
      ) : (
        <>
          {props.entry.status.state === "done" && (
            <HoverButton
              icon={<Icon icon={CheckIcon} size={14} />}
              aria-label={`Settle ${title}`}
              onClick={() => actions.settle(props.entry)}
            >
              Settle
            </HoverButton>
          )}
          <Menu>
            <Tip label="Snooze…">
              <MenuTrigger
                render={
                  <HoverButton
                    icon={<Icon icon={MoonIcon} size={14} />}
                    aria-label={`Snooze ${title}`}
                  />
                }
              />
            </Tip>
            <MenuContent align="end" className="min-w-[200px]">
              <SnoozeItems entry={props.entry} actions={actions} snoozed={props.snoozed} />
            </MenuContent>
          </Menu>
        </>
      )}
      <Tip label={props.pinned ? "Unpin thread" : "Pin thread"} shortcut="home.pin">
        <HoverButton
          icon={<Icon icon={props.pinned ? PushPinSlashIcon : PushPinIcon} size={14} />}
          aria-label={`${props.pinned ? "Unpin" : "Pin"} ${title}`}
          onClick={() => actions.setPinned(props.entry, !props.pinned)}
        />
      </Tip>
    </div>
  );
}

function HoverButton({
  icon,
  children,
  className,
  ...props
}: ComponentProps<"button"> & { icon: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[22px] items-center gap-1 rounded-sm px-[7px] text-xs font-medium text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent aria-expanded:text-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

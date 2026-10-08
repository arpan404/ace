import {
  ArrowUUpLeftIcon,
  CheckIcon,
  MoonIcon,
  PushPinIcon,
  PushPinSlashIcon,
} from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { SnoozeItems, useThreadActions } from "@/features/organize/index.ts";

/**
 * A row's quick actions, in place of its marks while the pointer or keyboard focus is on the
 * row: Unsettle on a settled row; on the others Settle once the work is done (Snooze until then),
 * then Pin or Unpin. Icons only, each with its tooltip; the context menu has the rest. They step
 * aside while the row's context menu is open.
 */
export function RowActions(props: {
  entry: ThreadListEntry;
  settled: boolean;
  pinned: boolean;
  snoozed: boolean;
}) {
  const actions = useThreadActions();
  const title = props.entry.title;
  return (
    <div className="absolute top-1 right-1 hidden items-center gap-px group-focus-within/row:flex group-hover/row:flex group-data-popup-open/row:invisible has-[[data-popup-open]]:flex">
      {props.settled ? (
        <IconButton
          icon={ArrowUUpLeftIcon}
          size="sm"
          label={`Unsettle ${title}`}
          tip="Unsettle"
          onClick={() => actions.unsettle(props.entry)}
        />
      ) : (
        <>
          {props.entry.status.state === "done" ? (
            <IconButton
              icon={CheckIcon}
              size="sm"
              label={`Settle ${title}`}
              tip="Settle"
              onClick={() => actions.settle(props.entry)}
            />
          ) : (
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    icon={MoonIcon}
                    size="sm"
                    label={`Snooze ${title}`}
                    tip={props.snoozed ? "Snoozed" : "Snooze…"}
                  />
                }
              />
              <MenuContent align="end" className="min-w-[200px]">
                <SnoozeItems entry={props.entry} actions={actions} snoozed={props.snoozed} />
              </MenuContent>
            </Menu>
          )}
          <IconButton
            icon={props.pinned ? PushPinSlashIcon : PushPinIcon}
            size="sm"
            label={`${props.pinned ? "Unpin" : "Pin"} ${title}`}
            tip={props.pinned ? "Unpin thread" : "Pin thread"}
            shortcut="home.pin"
            onClick={() => actions.setPinned(props.entry, !props.pinned)}
          />
        </>
      )}
    </div>
  );
}

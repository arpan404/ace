import type { ThreadListEntry } from "@ace/protocol";
import { useNow } from "@/lib/time.ts";
import {
  describeWake,
  eventSnoozeBackstopMs,
  eventSnoozes,
  snoozePresets,
  type EventSnooze,
} from "@ace/ui-core";
import { MenuItem, MenuLabel, MenuGroup, MenuSeparator } from "@/components/ui/menu.tsx";
import type { ThreadActions } from "./use-thread-actions.ts";

/** A snooze that ends on an event: its label, and what brings the thread back under it. */
function EventItem(props: { choice: EventSnooze; onPick(): void }) {
  return (
    <MenuItem onClick={props.onPick}>
      <span className="flex flex-col">
        {props.choice.label}
        <span className="text-xs text-subtle-foreground">{props.choice.detail}</span>
      </span>
    </MenuItem>
  );
}

/**
 * "Snooze": until it needs you (a live thread), the time presets, until the PR changes (a
 * thread with a pull request), plus Wake now on a snoozed thread. Menu or context menu.
 */
export function SnoozeItems(props: {
  entry: ThreadListEntry;
  actions: ThreadActions;
  snoozed: boolean;
}) {
  const now = useNow();
  const events = eventSnoozes(props.entry);
  const needs = events.find((choice) => choice.wake === "needs_you");
  const pr = events.find((choice) => choice.wake === "pr");
  const onEvent = (choice: EventSnooze) => () =>
    props.actions.snooze(
      props.entry,
      now + eventSnoozeBackstopMs,
      choice.wake,
      choice.label.toLowerCase(),
    );
  return (
    <>
      <MenuGroup>
        <MenuLabel>Snooze</MenuLabel>
        {needs && <EventItem choice={needs} onPick={onEvent(needs)} />}
        {needs && <MenuSeparator />}
        {snoozePresets(now).map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() =>
              props.actions.snooze(
                props.entry,
                preset.until,
                undefined,
                `until ${describeWake(preset.until, now)}`,
              )
            }
          >
            <span className="flex w-full items-center">
              {preset.label}
              <span className="ml-auto pl-[18px] text-xs text-subtle-foreground">
                {preset.detail}
              </span>
            </span>
          </MenuItem>
        ))}
        {pr && <EventItem choice={pr} onPick={onEvent(pr)} />}
      </MenuGroup>
      {props.snoozed && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => props.actions.wake(props.entry)}>Wake now</MenuItem>
        </>
      )}
    </>
  );
}

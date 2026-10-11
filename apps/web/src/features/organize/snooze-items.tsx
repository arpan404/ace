import { useNow } from "@/lib/time.ts";
import { snoozePresets } from "@ace/ui-core";
import { MenuItem, MenuLabel, MenuGroup, MenuSeparator } from "@/components/ui/menu.tsx";
import type { ThreadActions, ThreadTarget } from "./use-thread-actions.ts";

/** "Snooze until": the three presets, plus Wake now on a snoozed thread. Menu or context menu. */
export function SnoozeItems(props: {
  entry: ThreadTarget;
  actions: ThreadActions;
  snoozed: boolean;
}) {
  const now = useNow();
  return (
    <>
      <MenuGroup>
        <MenuLabel>Snooze until</MenuLabel>
        {snoozePresets(now).map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() => props.actions.snooze(props.entry, preset.until, now)}
          >
            <span className="flex w-full items-center">
              {preset.label}
              <span className="ml-auto pl-[18px] text-xs text-subtle-foreground">
                {preset.detail}
              </span>
            </span>
          </MenuItem>
        ))}
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

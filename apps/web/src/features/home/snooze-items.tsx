import { MoonIcon } from "@phosphor-icons/react";
import type { ThreadListEntry } from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { useNow } from "@/lib/time.ts";
import { MenuItem, MenuLabel, MenuGroup, MenuSeparator } from "@/components/ui/menu.tsx";
import { snoozePresets } from "./snooze.ts";
import type { ThreadActions } from "./use-thread-actions.ts";

/** "Snooze until": the three presets, plus Wake now on a snoozed thread. Menu or context menu. */
export function SnoozeItems(props: {
  entry: ThreadListEntry;
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
            icon={<Icon icon={MoonIcon} />}
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

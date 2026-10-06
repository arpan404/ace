import { useSidebarStore } from "@ace/client-react";
import { MoonIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useThreadActions } from "@/features/organize/index.ts";
import { useNow } from "@/lib/time.ts";
import { snoozePresets } from "@ace/ui-core";
import { useActivityState } from "./activity-state.tsx";
import { useFeedSource } from "./feed-source.ts";
import { readIdOf } from "./item-keys.ts";

/**
 * What to do with the picked items at once: mark the events and runs read, or snooze the
 * threads behind the requests. Approving many at once is never offered.
 */
export function PickedBar() {
  const { picked, clearPicked } = useActivityState();
  const source = useFeedSource();
  const sidebar = useSidebarStore();
  const actions = useThreadActions();
  const now = useNow();
  if (!picked.size) return null;
  const keys = [...picked];
  const readIds = keys.flatMap((key) => readIdOf(key) ?? []);
  const threads = [
    ...new Set(
      keys.flatMap((key) => (key.startsWith("interaction:") ? [key.split(":")[1] ?? ""] : [])),
    ),
  ].flatMap((id) => sidebar?.thread(id) ?? []);
  return (
    <div
      role="toolbar"
      aria-label="Picked items"
      className="glass absolute bottom-4 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1.5 rounded-lg py-1.5 pr-1.5 pl-3.5 text-ui"
    >
      <span className="mr-1.5 font-medium tabular-nums">{picked.size} picked</span>
      {readIds.length > 0 && (
        <Button
          size="sm"
          onClick={() => {
            source.markRead(readIds);
            clearPicked();
          }}
        >
          Mark read
        </Button>
      )}
      {threads.length > 0 && (
        <Menu>
          <MenuTrigger render={<Button size="sm">Snooze</Button>} />
          <MenuContent side="top" align="center">
            <MenuGroup>
              <MenuLabel>Snooze until</MenuLabel>
              {snoozePresets(now).map((preset) => (
                <MenuItem
                  key={preset.id}
                  icon={<Icon icon={MoonIcon} />}
                  onClick={() => {
                    for (const thread of threads) actions.snooze(thread, preset.until, now);
                    clearPicked();
                  }}
                >
                  {preset.label}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuContent>
        </Menu>
      )}
      <Button size="sm" variant="ghost" onClick={clearPicked}>
        Clear
      </Button>
    </div>
  );
}

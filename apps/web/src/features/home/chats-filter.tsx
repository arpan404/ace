import { CaretDownIcon } from "@ace/icons";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { PanelTitle, panelTitleText } from "@/components/ui/panel.tsx";
import { cn } from "@/lib/cn.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useOrganizer } from "@/features/organize/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { DeviceItems, ScopeMark, scopeNames, useScopeMachines } from "./device-filter.tsx";
import { useChatsDevice } from "./device-filter-state.ts";

/**
 * The Chats panel's title. While more than one device is connected it is "Chats" with a caret,
 * which opens the device filter (chats have no project, so only devices); chosen devices add
 * their mark, as Threads' title does. The choice is the Chats panel's own, apart from Threads'.
 */
export function ChatsFilter() {
  const machines = useMachines();
  const deviceId = useChatsDevice();
  const organizer = useOrganizer();
  const chosen = useScopeMachines(deviceId);
  if (machines.length < 2) return <PanelTitle>Chats</PanelTitle>;
  const names = scopeNames(chosen);
  return (
    <span className="flex min-w-0 flex-1">
      <Menu>
        <Tip label={names ? `Chats on ${names}` : "Filter chats"}>
          <MenuTrigger
            aria-label={`Chats, Device: ${names ?? "All devices"}`}
            className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover aria-expanded:bg-active"
          >
            {/* The place's name always reads whole; the device beside it shortens instead. */}
            <span className={cn(panelTitleText, "shrink-0")}>Chats</span>
            {names && (
              <span
                aria-hidden
                className="inline-flex min-w-0 items-center gap-1.5 text-sm text-subtle-foreground"
              >
                <ScopeMark chosen={chosen} />
              </span>
            )}
            <CaretDownIcon aria-hidden size={12} className="shrink-0 text-muted-foreground" />
          </MenuTrigger>
        </Tip>
        <MenuContent align="start" className="max-h-[60vh] min-w-56 overflow-y-auto">
          <DeviceItems device={deviceId} onDevice={(next) => organizer.setChatDevice(next)} />
        </MenuContent>
      </Menu>
    </span>
  );
}

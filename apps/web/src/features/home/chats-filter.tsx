import { CaretDownIcon } from "@phosphor-icons/react";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { PanelTitle, panelTitleText } from "@/components/ui/panel.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useOrganizer } from "@/features/organize/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { DeviceItems } from "./device-filter.tsx";
import { useChatsDevice } from "./device-filter-state.ts";

/**
 * The Chats panel's title. While more than one device is connected it is "Chats" with a caret,
 * which opens the device filter (chats have no project, so only devices); a chosen device adds
 * its mark, as Threads' title does. The choice is the Chats panel's own, apart from Threads'.
 */
export function ChatsFilter() {
  const machines = useMachines();
  const deviceId = useChatsDevice();
  const organizer = useOrganizer();
  if (machines.length < 2) return <PanelTitle>Chats</PanelTitle>;
  const device = machines.find((machine) => machine.id === deviceId);
  return (
    <span className="flex min-w-0 flex-1">
      <Menu>
        <Tip label={device ? `Chats on ${device.name}` : "Filter chats"}>
          <MenuTrigger
            aria-label={`Chats, Device: ${device?.name ?? "All devices"}`}
            className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover aria-expanded:bg-active"
          >
            <span className={panelTitleText}>Chats</span>
            {device && (
              <span
                aria-hidden
                className="inline-flex min-w-0 items-center gap-1.5 text-sm text-subtle-foreground"
              >
                <MachineMark icon={device.icon} primary={device.primary} />
                <span className="truncate">{device.name}</span>
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

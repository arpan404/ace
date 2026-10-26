import { CaretDownIcon, DevicesIcon } from "@phosphor-icons/react";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { useOrganizer } from "@/features/organize/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { useSidebarDevice } from "./device-filter-state.ts";

const all = "\u0000all";
const allLabel = (
  <span className="inline-flex min-w-0 items-center gap-1.5">
    <DevicesIcon aria-hidden size={14} className="shrink-0" />
    <span className="truncate">All devices</span>
  </span>
);

/** Filter the flat task list by device, only while there is a choice of devices. */
export function DeviceFilter() {
  const machines = useMachines();
  const device = useSidebarDevice();
  const organizer = useOrganizer();
  if (machines.length < 2) return null;
  const selected = machines.find((machine) => machine.id === device);
  const label = selected?.name ?? "All devices";
  return (
    <div className="flex h-9 shrink-0 items-center px-2">
      <Menu>
        <MenuTrigger
          aria-label={`Device filter: ${label}`}
          className="inline-flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2.5 text-sm font-medium text-muted-foreground focus-ring touch-hit transition-colors duration-(--motion-fast) hover:bg-sidebar-accent hover:text-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-foreground"
        >
          {selected ? (
            <MachineLabel name={label} icon={selected.icon} primary={selected.primary} />
          ) : (
            allLabel
          )}
          <CaretDownIcon aria-hidden size={14} className="ml-auto shrink-0" />
        </MenuTrigger>
        <MenuContent
          align="start"
          className="max-h-[60vh] w-(--anchor-width) min-w-0 overflow-y-auto"
        >
          <MenuRadioGroup
            value={device ?? all}
            onValueChange={(value) =>
              organizer.setDevice(typeof value === "string" && value !== all ? value : undefined)
            }
          >
            <MenuRadioItem value={all} closeOnClick>
              {allLabel}
            </MenuRadioItem>
            {machines.map((machine) => (
              <MenuRadioItem
                key={machine.id}
                value={machine.id}
                aria-label={machine.name}
                closeOnClick
              >
                <MachineLabel name={machine.name} icon={machine.icon} primary={machine.primary} />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  );
}

import { DevicesIcon } from "@phosphor-icons/react";
import {
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
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

/** Filter the Threads panel by device, as a submenu, only while there is a choice of devices. */
export function DeviceFilter() {
  const machines = useMachines();
  const device = useSidebarDevice();
  const organizer = useOrganizer();
  if (machines.length < 2) return null;
  const selected = machines.find((machine) => machine.id === device);
  const label = selected?.name ?? "All devices";
  return (
    <>
      <MenuSub>
        <MenuSubTrigger aria-label={`Device filter: ${label}`}>
          {selected ? (
            <MachineLabel name={label} icon={selected.icon} primary={selected.primary} />
          ) : (
            allLabel
          )}
        </MenuSubTrigger>
        <MenuContent side="right" align="start" className="max-h-[60vh] overflow-y-auto">
          <DeviceItems device={device} onDevice={(next) => organizer.setDevice(next)} />
        </MenuContent>
      </MenuSub>
      <MenuSeparator />
    </>
  );
}

/** All devices, then each device, as radio items: the device filters' one list. */
export function DeviceItems(props: {
  device: string | undefined;
  onDevice(device: string | undefined): void;
}) {
  const machines = useMachines();
  return (
    <MenuRadioGroup
      value={props.device ?? all}
      onValueChange={(value) =>
        props.onDevice(typeof value === "string" && value !== all ? value : undefined)
      }
    >
      <MenuRadioItem value={all} closeOnClick>
        {allLabel}
      </MenuRadioItem>
      {machines.map((machine) => (
        <MenuRadioItem key={machine.id} value={machine.id} aria-label={machine.name} closeOnClick>
          <MachineLabel name={machine.name} icon={machine.icon} primary={machine.primary} />
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

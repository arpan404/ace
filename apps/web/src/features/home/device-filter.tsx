import { DevicesIcon } from "@ace/icons";
import type { ReactNode } from "react";
import {
  MenuCheckboxItem,
  MenuContent,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useOrganizer } from "@/features/organize/index.ts";
import { type Machine, useMachines } from "@/lib/machines.ts";
import { type DeviceScope, toggled, useSidebarDevice } from "./device-filter-state.ts";

/** The machines a filter lets through, in the machines' order (none for every device). */
export function useScopeMachines(scope: DeviceScope): readonly Machine[] {
  const machines = useMachines();
  return scope ? machines.filter((machine) => scope.includes(machine.id)) : [];
}

/** The chosen devices in words: one device's name, or each name in turn. */
export const scopeNames = (chosen: readonly Machine[]): string | undefined =>
  chosen.length ? chosen.map((machine) => machine.name).join(", ") : undefined;

/**
 * The chosen devices as a filter shows them: the first one's glyph and name, then how many
 * more ("+2"). The name shortens beside other text; the count always reads whole.
 */
export function ScopeMark(props: { chosen: readonly Machine[]; size?: number }) {
  const [first, ...rest] = props.chosen;
  if (!first) return null;
  return (
    <>
      <MachineMark icon={first.icon} primary={first.primary} size={props.size} />
      <span className="min-w-0 truncate">{first.name}</span>
      {rest.length > 0 && (
        <span className="shrink-0 font-normal text-muted-foreground">+{rest.length}</span>
      )}
    </>
  );
}

/** One row's glyph and name, with 16px icons in one column. */
function Row(props: { children: ReactNode }) {
  return <span className="inline-flex min-w-0 items-center gap-[9px]">{props.children}</span>;
}

/** Filter the Threads panel by device, as a submenu, only while there is a choice of devices. */
export function DeviceFilter() {
  const machines = useMachines();
  const device = useSidebarDevice();
  const chosen = useScopeMachines(device);
  const organizer = useOrganizer();
  if (machines.length < 2) return null;
  return (
    <>
      <MenuSub>
        <MenuSubTrigger aria-label={`Device filter: ${scopeNames(chosen) ?? "All devices"}`}>
          <Row>
            {chosen.length ? (
              <ScopeMark chosen={chosen} size={16} />
            ) : (
              <>
                <DevicesIcon aria-hidden size={16} className="shrink-0" />
                <span className="truncate">All devices</span>
              </>
            )}
          </Row>
        </MenuSubTrigger>
        <MenuContent side="right" align="start" className="max-h-[60vh] overflow-y-auto">
          <DeviceItems device={device} onDevice={(next) => organizer.setDevice(next)} />
        </MenuContent>
      </MenuSub>
      <MenuSeparator />
    </>
  );
}

/**
 * All devices, then each device, the device filters' one list. All devices shows everything
 * and closes the menu; a device ticks in or out and the menu stays open, so several can be
 * chosen together.
 */
export function DeviceItems(props: { device: DeviceScope; onDevice(device: DeviceScope): void }) {
  const machines = useMachines();
  const known = machines.map((machine) => machine.id);
  return (
    <>
      <MenuCheckboxItem
        checked={!props.device}
        onCheckedChange={() => props.onDevice(undefined)}
        closeOnClick
      >
        <Row>
          <DevicesIcon aria-hidden size={16} className="shrink-0" />
          <span className="truncate">All devices</span>
        </Row>
      </MenuCheckboxItem>
      {machines.map((machine) => (
        <MenuCheckboxItem
          key={machine.id}
          aria-label={machine.name}
          checked={props.device?.includes(machine.id) ?? false}
          onCheckedChange={() => props.onDevice(toggled(props.device, machine.id, known))}
        >
          <Row>
            <MachineMark icon={machine.icon} primary={machine.primary} size={16} />
            <span className="truncate">{machine.name}</span>
          </Row>
        </MenuCheckboxItem>
      ))}
    </>
  );
}

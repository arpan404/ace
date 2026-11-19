import { useMemo } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useMachines } from "@/lib/machines.ts";

/** The devices a filter lets through: never empty, undefined for every device. */
export type DeviceScope = readonly string[] | undefined;

/** Whether a filter lets `device`'s threads through. */
export const inScope = (scope: DeviceScope, device: string): boolean =>
  !scope || scope.includes(device);

/**
 * `device` ticked or unticked in a filter of `known` devices. Ticking a device while every
 * device shows narrows to it alone; unticking the last one, or ticking the last one missing,
 * is every device again.
 */
export function toggled(scope: DeviceScope, device: string, known: readonly string[]): DeviceScope {
  const next = !scope
    ? [device]
    : scope.includes(device)
      ? scope.filter((id) => id !== device)
      : [...scope, device];
  return next.length === 0 || known.every((id) => next.includes(id)) ? undefined : next;
}

/** The known devices a filter still names, while there is a choice of devices. */
function useKnownDevices(devices: readonly string[] | undefined): DeviceScope {
  const machines = useMachines();
  return useMemo(() => {
    if (!devices || machines.length < 2) return undefined;
    const known = machines.filter((machine) => devices.includes(machine.id));
    return known.length === 0 || known.length === machines.length
      ? undefined
      : known.map((machine) => machine.id);
  }, [devices, machines]);
}

/** Forgotten devices or a window with only one device always show the whole list. */
export function useSidebarDevice(): DeviceScope {
  return useKnownDevices(useOrganizerState().device);
}

/** The Chats panel's device filter, kept apart from Threads' (same rules). */
export function useChatsDevice(): DeviceScope {
  return useKnownDevices(useOrganizerState().chatDevice);
}

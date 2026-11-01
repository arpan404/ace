import { useOrganizerState } from "@/features/organize/index.ts";
import { useMachines } from "@/lib/machines.ts";

/** A device filter that still names a known device, while there is a choice of devices. */
function useKnownDevice(device: string | undefined): string | undefined {
  const machines = useMachines();
  return machines.length > 1 && machines.some((machine) => machine.id === device)
    ? device
    : undefined;
}

/** A forgotten device or a window with only one device always shows the whole list. */
export function useSidebarDevice(): string | undefined {
  return useKnownDevice(useOrganizerState().device);
}

/** The Chats panel's device filter, kept apart from Threads' (same rules). */
export function useChatsDevice(): string | undefined {
  return useKnownDevice(useOrganizerState().chatDevice);
}

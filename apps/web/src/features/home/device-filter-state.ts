import { useOrganizerState } from "@/features/organize/index.ts";
import { useMachines } from "@/lib/machines.ts";

/** A forgotten device or a window with only one device always shows the whole list. */
export function useSidebarDevice(): string | undefined {
  const { device } = useOrganizerState();
  const machines = useMachines();
  return machines.length > 1 && machines.some((machine) => machine.id === device)
    ? device
    : undefined;
}

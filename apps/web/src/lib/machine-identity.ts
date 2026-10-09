import type { MachineIcon } from "@ace/protocol";
import { useHostIdentity } from "./host-name.ts";
import { useMachines } from "./machines.ts";

/** Live identity wins over names saved when a thread started, including legacy OS host IDs. */
export function useMachineIdentity(saved?: {
  host: string;
  name: string;
  icon?: MachineIcon | undefined;
}) {
  const own = useHostIdentity();
  const machines = useMachines();
  if (!saved || saved.host === own?.hostId || saved.host === own?.hostname)
    return { name: own?.displayName ?? "This machine", icon: own?.icon, primary: true };
  const known = machines.find((machine) => machine.id === saved.host);
  return {
    name: known?.name ?? saved.name,
    icon: known?.icon ?? saved.icon,
    primary: known?.primary ?? false,
  };
}

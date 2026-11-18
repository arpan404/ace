import { linkersOf } from "@ace/ui-core/fleet-map";
import { useMutation } from "@tanstack/react-query";
import { HairlineRow, RowAction } from "@/components/hairline-row.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { setDeviceScope } from "./data/fleet.ts";
import type { Fleet } from "./data/use-fleet.ts";

/**
 * For each machine linked to `machine`, whether it may bring projects and threads here
 * ("Continue on…", "Open on…", ADR 0101), with Allow projects or Don't allow projects. The
 * change is to that link's own device here; it keeps its credential, so nothing pairs again.
 */
export function LinkProjectsRows(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const toast = useToast();
  const devices = fleet.devices.get(machine.id)?.data ?? [];
  const change = useMutation({
    mutationFn: async (input: { linker: string; deviceId: string; allowed: boolean }) => {
      if (!machine.client) throw new Error(`${machine.name} is offline.`);
      await setDeviceScope(machine.client, {
        deviceId: input.deviceId,
        scope: "projects",
        allowed: input.allowed,
        commandId: crypto.randomUUID(),
      });
      await fleet.refresh([machine.id, input.linker]);
    },
    onError: (error) => toast.error({ title: "Couldn't change it", description: error.message }),
  });
  if (!machine.client) return null;
  return linkersOf(machine.id, fleet.facts).flatMap((linker) => {
    const device = devices.find((each) => each.id === linker.deviceId);
    if (!device) return [];
    const allowed = device.scopes.includes("projects");
    return [
      <HairlineRow
        key={linker.id}
        id={`projects-from-${linker.id}`}
        title={`Projects from ${linker.name}`}
        sub={
          allowed
            ? `${linker.name} can continue threads and open projects here.`
            : `${linker.name} can't continue threads or open projects here.`
        }
        actions={
          <RowAction
            reveal={allowed}
            className={allowed ? undefined : "text-foreground"}
            disabled={change.isPending}
            onClick={() =>
              change.mutate({ linker: linker.id, deviceId: device.id, allowed: !allowed })
            }
          >
            {allowed ? "Don't allow projects" : "Allow projects"}
          </RowAction>
        }
      />,
    ];
  });
}

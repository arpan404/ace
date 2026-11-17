import { ConnectedApps } from "@/features/connected-apps/index.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { primaryMachineId } from "@/lib/machines.ts";
import { ConnectApp } from "./connect-app.tsx";
import { FleetBack } from "./fleet-back.tsx";
import { MachineNotFound, useFleetMachine } from "./fleet-machine-page.tsx";
import { SettingsBody } from "./settings-body.tsx";

/**
 * Settings › Fleet › a machine › Apps and webhooks: the outside apps connected to it, how to
 * connect another, and the automation webhooks that reach it.
 */
export function FleetMachineAppsPage(props: { id: string }) {
  const { machine } = useFleetMachine(props.id);
  if (!machine) return <MachineNotFound />;
  const back = (
    <FleetBack
      machine={{ id: machine.primary ? primaryMachineId : machine.id, name: machine.name }}
    />
  );
  return (
    <SettingsBody page="Apps and webhooks" back={back}>
      {machine.client ? (
        <MachineScope machine={machine}>
          <ConnectedApps
            machine={machine}
            client={machine.client}
            connect={<ConnectApp client={machine.client} />}
          />
        </MachineScope>
      ) : (
        <p className="text-ui text-muted-foreground">
          {machine.name}'s apps and webhooks show when it's back online.
        </p>
      )}
    </SettingsBody>
  );
}

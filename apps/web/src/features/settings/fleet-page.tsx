import { DesktopTowerIcon, DeviceMobileIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { HairlineRow, RowAction, RowGroup, RowTile } from "@/components/hairline-row.tsx";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { DaemonSettings } from "./daemon-settings.tsx";
import { reachDependents, reachedThrough, type Dependents } from "@ace/ui-core/fleet-map";
import { settingKeys } from "./data/setting-keys.ts";
import { useFleet, type Fleet } from "./data/use-fleet.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { FleetDevices } from "./fleet-devices.tsx";
import { FleetMachines } from "./fleet-machines.tsx";
import { MoreOptions } from "./fleet-more.tsx";
import { ReachRows } from "./fleet-reach.tsx";
import { FleetSoftware } from "./fleet-software.tsx";
import { FleetFrame, useFleetAdd } from "./fleet-frame.tsx";
import { WorkingAcrossMachines } from "./fleet-working.tsx";

/** What reaches this computer now: its paired devices and the machines linked to it. */
function dependentsOf(fleet: Fleet): Dependents {
  const own = fleet.machines.find((machine) => machine.primary);
  return own ? reachDependents(own.id, fleet.joined, fleet.facts, fleet.devicesRead) : [];
}

/**
 * Settings › Fleet › Overview: every machine and device as a quiet row that opens it, how this
 * computer is reached, how the machines work together, which computer this window talks to, and
 * the rarer choices folded under More options. A fleet of one says what to do next instead of
 * showing empty lists.
 */
export function FleetPage() {
  const fleet = useFleet();
  const account = useAccountMachines(fleet.machines);
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const networks = useRemoteStatus().data?.networks;
  const [added, setAdded] = useState<string>();
  const own = fleet.machines.find((machine) => machine.primary);
  const solo = fleet.machines.length + account.only.length <= 1;
  const on = enabled.loaded ? enabled.value : true;
  const dependents = dependentsOf(fleet);
  return (
    <FleetFrame onAdded={setAdded}>
      <FleetSoftware fleet={fleet} />
      <FleetMachines
        fleet={fleet}
        account={account}
        ownLine={reachedThrough(on, networks)}
        added={added}
      />
      {solo && <NextSteps />}
      <FleetDevices fleet={fleet} />
      {own && (
        <ReachRows
          machine={own}
          label="How this computer is reached"
          dependents={dependents}
          signIn
        />
      )}
      {!solo && <WorkingAcrossMachines fleet={fleet} />}
      <DaemonSettings />
      <MoreOptions dependents={dependents} />
    </FleetFrame>
  );
}

/** A fleet of one: two sentences on what to add, each with its action. */
function NextSteps() {
  const add = useFleetAdd();
  return (
    <RowGroup label="Next">
      <HairlineRow
        tile={
          <RowTile>
            <DesktopTowerIcon aria-hidden size={15} />
          </RowTile>
        }
        title="Add your other computers"
        sub="Install ace there and sign in with the same account, or pair it. Your agents can then work across them."
        actions={
          <RowAction className="text-foreground" onClick={() => add?.addMachine()}>
            Add machine
          </RowAction>
        }
      />
      <HairlineRow
        tile={
          <RowTile>
            <DeviceMobileIcon aria-hidden size={15} />
          </RowTile>
        }
        title="Follow along on your phone"
        sub="Open app.acehq.dev on it and sign in, or pair it with a code."
        actions={
          <RowAction className="text-foreground" onClick={() => add?.pairDevice()}>
            Pair a device
          </RowAction>
        }
      />
    </RowGroup>
  );
}

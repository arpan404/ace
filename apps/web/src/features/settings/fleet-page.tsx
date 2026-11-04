import { DesktopTowerIcon, DeviceMobileIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { HairlineRow, RowAction, RowGroup, RowTile } from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { AddMachine } from "./add-machine.tsx";
import { DaemonSettings } from "./daemon-settings.tsx";
import { linkersOf } from "./data/fleet-links.ts";
import { fleetLede, reachedThrough } from "./data/fleet-words.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useFleet, type Fleet } from "./data/use-fleet.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { FleetDevices } from "./fleet-devices.tsx";
import { FleetMachines } from "./fleet-machines.tsx";
import { MoreOptions } from "./fleet-more.tsx";
import { ReachRows } from "./fleet-reach.tsx";
import { FleetSoftware } from "./fleet-software.tsx";
import { FleetTabs } from "./fleet-tabs.tsx";
import { WorkingAcrossMachines } from "./fleet-working.tsx";
import { PairDevice } from "./pair-device.tsx";
import { SettingsBody } from "./settings-body.tsx";

/** What reaches this computer now: its paired devices and the machines linked to it. */
function dependentsOf(fleet: Fleet): string[] {
  const own = fleet.machines.find((machine) => machine.primary);
  if (!own) return [];
  return [
    ...fleet.joined
      .filter((device) => device.on.some((entry) => entry.machine === own.id))
      .map((device) => device.name),
    ...linkersOf(own.id, fleet.facts).map((linker) => linker.name),
  ];
}

/**
 * Settings › Fleet: one sentence on whether this computer can be reached, every machine and
 * device as a quiet row that opens it, how this computer is reached, how the machines work
 * together, which computer this window talks to, and the rarer choices folded under More options. A fleet of one says what to do
 * next instead of showing empty lists.
 */
export function FleetPage() {
  const fleet = useFleet();
  const account = useAccountMachines(fleet.machines);
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const networks = useRemoteStatus().data?.networks;
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string>();
  const own = fleet.machines.find((machine) => machine.primary);
  const count = fleet.machines.length + account.only.length;
  const solo = count <= 1;
  const on = enabled.loaded ? enabled.value : true;
  const dependents = dependentsOf(fleet);
  const add = (
    <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
      Add machine
    </Button>
  );
  return (
    <SettingsBody
      page="Fleet"
      tabs={<FleetTabs />}
      lede={fleetLede({
        machines: count,
        devices: fleet.joined.length,
        enabled: on,
        networks: enabled.loaded ? networks : undefined,
      })}
      titleActions={
        !solo && (
          <>
            <PairDevice />
            {add}
          </>
        )
      }
    >
      <FleetSoftware fleet={fleet} />
      <FleetMachines
        fleet={fleet}
        account={account}
        ownLine={reachedThrough(on, networks)}
        added={added}
      />
      {solo && <NextSteps onAdd={() => setAdding(true)} />}
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
      {adding && <AddMachine onClose={() => setAdding(false)} onAdded={setAdded} />}
    </SettingsBody>
  );
}

/** A fleet of one: two sentences on what to add, each with its action. */
function NextSteps(props: { onAdd(): void }) {
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
          <RowAction className="text-foreground" onClick={props.onAdd}>
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
        actions={<PairDevice variant="ghost" />}
      />
    </RowGroup>
  );
}

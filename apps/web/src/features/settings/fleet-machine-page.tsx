import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { RowTile, StateWords } from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { primaryMachineId, type Machine } from "@/lib/machines.ts";
import { linkersOf } from "./data/fleet-links.ts";
import { machineState } from "./data/fleet-words.ts";
import { useFleet, type Fleet } from "./data/use-fleet.ts";
import { MoreOptions } from "./fleet-more.tsx";
import { ReachRows } from "./fleet-reach.tsx";
import { MachineAccount } from "./machine-account.tsx";
import { MachineAgents } from "./machine-agents.tsx";
import { MachineDevices, RemoveMachine } from "./machine-devices.tsx";
import { MachineEditor } from "./machine-editor.tsx";
import { MachinePause } from "./machine-pause.tsx";
import { MachineSoftware } from "./machine-software.tsx";
import { useMachineAction } from "./machine-unlock.tsx";
import { SettingsBody } from "./settings-body.tsx";

const back = (
  <Link
    to="/settings/remote"
    aria-label="Back to Fleet"
    className="inline-flex items-center gap-1 rounded-xs text-muted-foreground focus-ring hover:text-foreground"
  >
    <CaretLeftIcon aria-hidden size={12} />
    Fleet
  </Link>
);

/** What reaches `machine` now: this window (for another machine), its devices and its linkers. */
function dependentsOf(machine: Machine, fleet: Fleet): string[] {
  return [
    ...(machine.primary ? [] : ["This window"]),
    ...(fleet.devices.get(machine.id)?.data ?? [])
      .filter((device) => !device.self)
      .map((device) => device.name),
    ...linkersOf(machine.id, fleet.facts).map((linker) => linker.name),
  ];
}

/**
 * One machine in the fleet: its state and the one action it needs, how it's reached, whether it
 * takes new work, its security, its software, its agents both ways, the devices that open it and, alone at the bottom, removing
 * it from the fleet.
 */
export function FleetMachinePage(props: { id: string }) {
  const fleet = useFleet();
  // This window's own machine is addressed as "primary", so its page survives its host id loading.
  const machine =
    props.id === primaryMachineId
      ? fleet.machines.find((entry) => entry.primary)
      : fleet.byId(props.id);
  if (!machine)
    return (
      <SettingsBody page="Machine not found" back={back}>
        <p role="alert" className="mt-4 text-muted-foreground">
          This machine isn't in the fleet any more.
        </p>
      </SettingsBody>
    );
  return <MachinePage machine={machine} fleet={fleet} />;
}

function MachinePage(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const pool = useMachinePool();
  const [editing, setEditing] = useState(false);
  const action = useMachineAction(machine);
  const state = machineState(machine.status, !!machine.failed);
  const dependents = dependentsOf(machine, fleet);
  return (
    <SettingsBody
      page={machine.name}
      back={back}
      icon={
        <RowTile size="page">
          <MachineMark icon={machine.icon} primary={machine.primary} size={20} />
        </RowTile>
      }
      lede={
        <>
          <StateWords tone={state.tone}>{state.words}</StateWords>
          {machine.primary && " · this computer"}
          {action.prompt && <div className="mt-2">{action.prompt}</div>}
        </>
      }
      titleActions={
        <>
          <Button
            id="host.displayName"
            size="sm"
            variant="ghost"
            disabled={!machine.client}
            onClick={() => setEditing(true)}
          >
            Rename
          </Button>
          {action.button}
        </>
      }
    >
      {machine.client ? (
        <MachineScope machine={machine}>
          <ReachRows machine={machine} label="How it's reached" dependents={dependents} />
        </MachineScope>
      ) : (
        <p className="text-ui text-muted-foreground">
          How it's reached, its agents and its devices show when it's back online.
        </p>
      )}
      <MachinePause machine={machine} />
      <MachineAccount machine={machine} label="Security" />
      <MachineSoftware machine={machine} fleet={fleet} />
      <MachineAgents machine={machine} fleet={fleet} />
      <MachineDevices machine={machine} fleet={fleet} />
      {machine.client && (
        <MachineScope machine={machine}>
          <MoreOptions dependents={dependents} />
        </MachineScope>
      )}
      {!machine.primary && <RemoveMachine machine={machine} fleet={fleet} />}
      {editing && (
        <MachineEditor
          machine={machine}
          onClose={() => setEditing(false)}
          onSaved={async (name, icon) => {
            if (!machine.primary) await pool?.rename(machine.id, name, icon);
          }}
        />
      )}
    </SettingsBody>
  );
}

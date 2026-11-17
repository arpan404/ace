import { DotsThreeIcon } from "@ace/icons";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  HairlineRow,
  RowGroup,
  RowTile,
  StateWords,
  rowLinkClass,
} from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { primaryMachineId, type Machine } from "@/lib/machines.ts";
import { part } from "@/lib/suit-part.ts";
import { clientDependents, machineState, type Dependents } from "@ace/ui-core/fleet-map";
import { DaemonSettings } from "./daemon-settings.tsx";
import { useFleet, type Fleet } from "./data/use-fleet.ts";
import { FleetBack } from "./fleet-back.tsx";
import { MoreOptions } from "./fleet-more.tsx";
import { ReachRows } from "./fleet-reach.tsx";
import { MachineAccount } from "./machine-account.tsx";
import { LinksRow, MachineAgents } from "./machine-agents.tsx";
import { MachineDevices, RemoveMachine } from "./machine-devices.tsx";
import { MachineEditor } from "./machine-editor.tsx";
import { useMachineSwitch } from "./machine-on-here.tsx";
import { useMachinePause } from "./machine-pause.tsx";
import { MachineSoftware, useSoftwareSummary } from "./machine-software.tsx";
import { useMachineAction } from "./machine-unlock.tsx";
import { SettingsBody } from "./settings-body.tsx";

/** What reaches `machine` now: this window (for another machine), its devices and its linkers. */
function dependentsOf(machine: Machine, fleet: Fleet): Dependents {
  return clientDependents({
    machine: machine.id,
    devices: fleet.joined,
    machines: fleet.facts,
    read: fleet.reads,
    viewer: machine.primary ? undefined : "This window",
  });
}

/** The machine as its pages address it: this window's own is "primary". */
export function useFleetMachine(id: string): { machine: Machine | undefined; fleet: Fleet } {
  const fleet = useFleet();
  const machine =
    id === primaryMachineId ? fleet.machines.find((entry) => entry.primary) : fleet.byId(id);
  return { machine, fleet };
}

export function MachineNotFound() {
  return (
    <SettingsBody page="Machine not found" back={<FleetBack />}>
      <p role="alert" className="mt-4 text-muted-foreground">
        This machine isn't in the fleet any more.
      </p>
    </SettingsBody>
  );
}

/**
 * One machine in the fleet. The header says its state and version and holds Pause new work, with
 * Rename, Check for updates and turning it off on this device under ⋯. Then how it's reached
 * (with its links), its agents, the devices that open it, its apps and webhooks as one row that
 * opens their page, its rarer options and, alone at the bottom, removing it from the fleet. This
 * computer's page also holds this window's connection.
 */
export function FleetMachinePage(props: { id: string }) {
  const { machine, fleet } = useFleetMachine(props.id);
  if (!machine) return <MachineNotFound />;
  return <MachinePage machine={machine} fleet={fleet} />;
}

function MachinePage(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const pool = useMachinePool();
  const [editing, setEditing] = useState(false);
  const action = useMachineAction(machine);
  const pause = useMachinePause(machine);
  const software = useSoftwareSummary(machine, fleet);
  const toggle = useMachineSwitch(machine);
  const state = machineState(machine.status, !!machine.failed);
  const dependents = dependentsOf(machine, fleet);
  const others = fleet.machines.filter((entry) => entry.id !== machine.id);
  const address = machine.primary ? primaryMachineId : machine.id;
  return (
    <SettingsBody
      page={machine.name}
      back={<FleetBack />}
      icon={
        <RowTile size="page">
          <MachineMark icon={machine.icon} primary={machine.primary} size={20} />
        </RowTile>
      }
      lede={
        <>
          <StateWords tone={state.tone}>{state.words}</StateWords>
          {machine.primary && " · this computer"}
          {software?.line && ` · ${software.line.replace(/\.$/, "")}`}
          {pause?.line && <div className="mt-1">{pause.line}</div>}
          {action.prompt && <div className="mt-2">{action.prompt}</div>}
        </>
      }
      titleActions={
        <>
          {toggle?.off && (
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Turn on ${machine.name} on this device`}
              onClick={toggle.toggle}
            >
              Turn on
            </Button>
          )}
          {pause?.button}
          {action.button}
          <Menu>
            <MenuTrigger
              id="host.displayName"
              render={
                <IconButton icon={DotsThreeIcon} size="sm" label={`More for ${machine.name}`} />
              }
            />
            <MenuContent align="end">
              <MenuItem disabled={!machine.client} onClick={() => setEditing(true)}>
                Rename
              </MenuItem>
              {software?.check && <MenuItem onClick={software.check}>Check for updates</MenuItem>}
              {toggle && !toggle.off && (
                <MenuItem
                  reason="Nothing here connects to it, and its threads are hidden. It stays paired."
                  onClick={toggle.toggle}
                >
                  Turn off on this device
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </>
      }
    >
      {machine.client ? (
        <MachineScope machine={machine}>
          <ReachRows machine={machine} label="Reached through" dependents={dependents}>
            {others.length > 0 && <LinksRow machine={machine} fleet={fleet} others={others} />}
          </ReachRows>
        </MachineScope>
      ) : (
        <p className="text-ui text-muted-foreground">
          {machine.status === "off"
            ? "It's off on this device. Turn it on to see how it's reached, its agents and its devices."
            : "How it's reached, its agents and its devices show when it's back online."}
        </p>
      )}
      <MachineAccount machine={machine} label="Security" />
      <MachineSoftware machine={machine} fleet={fleet} />
      <MachineAgents machine={machine} fleet={fleet} />
      <MachineDevices machine={machine} fleet={fleet} />
      {machine.client && (
        <RowGroup label="More">
          <HairlineRow
            data-row="machine-apps"
            link={
              <Link
                to="/settings/remote/$machine/apps"
                params={{ machine: address }}
                {...part("link", undefined, "row")}
                className={rowLinkClass}
              >
                Apps and webhooks
              </Link>
            }
            title="Apps and webhooks"
            sub="Outside apps connected to it, and automation webhooks"
          />
        </RowGroup>
      )}
      {machine.primary && <DaemonSettings />}
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

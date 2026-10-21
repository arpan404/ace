import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SettingNote, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { machineProblem, machineStatus } from "@/lib/machine-status.ts";
import { primaryMachineId, type Machine } from "@/lib/machines.ts";
import { AddMachine } from "./add-machine.tsx";
import { fleetProblem } from "./data/fleet.ts";
import { listNames } from "./data/list-names.ts";
import { reach, unlinkedWith, type LinkGap } from "./data/fleet-links.ts";
import { useFleet, type Fleet } from "./data/use-fleet.ts";
import { FleetDevices } from "./fleet-devices.tsx";
import { FleetRules } from "./fleet-rules.tsx";

/**
 * Settings › Fleet: every machine this window reaches and whether each can use the others, the
 * access rules they share, and the phones, tablets and browsers paired to them.
 */
export function FleetPage() {
  const fleet = useFleet();
  return (
    <>
      <FleetMachines fleet={fleet} />
      <FleetRules machines={fleet.machines} />
      <FleetDevices fleet={fleet} />
    </>
  );
}

function FleetMachines(props: { fleet: Fleet }) {
  const { fleet } = props;
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string>();
  const handled = useRef<string>(undefined);
  const toast = useToast();
  const linkAll = (gaps: readonly LinkGap[]) =>
    fleet.link.mutate(gaps, {
      onSuccess: () => toast.add({ title: "Machines linked" }),
      onError: (error) =>
        toast.error({ title: "Some machines didn't link", description: error.message }),
    });
  // A machine just added links with every other one as soon as its links can be read.
  const newGaps = added ? fleet.gaps.filter((gap) => gap.from === added || gap.to === added) : [];
  const ready = added !== undefined && fleet.links.get(added)?.isSuccess === true;
  useEffect(() => {
    if (!ready || !added || handled.current === added || fleet.link.isPending) return;
    handled.current = added;
    if (newGaps.length) linkAll(newGaps);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once the new machine is readable
  }, [ready]);
  return (
    <SettingSection
      label="Machines"
      anchor="fleet.link"
      note={
        fleet.machines.length > 1
          ? "Linked machines can use each other: agents start threads and use browsers there."
          : undefined
      }
      actions={
        <>
          {fleet.gaps.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={fleet.link.isPending}
              onClick={() => linkAll(fleet.gaps)}
            >
              {fleet.link.isPending ? "Linking…" : "Link all"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            Add machine
          </Button>
        </>
      }
    >
      {fleet.machines.map((machine) => (
        <MachineRow key={machine.id} machine={machine} fleet={fleet} onLink={linkAll} />
      ))}
      {fleet.machines.length === 1 && (
        <SettingNote>Add another computer running ace to work across both.</SettingNote>
      )}
      {adding && <AddMachine onClose={() => setAdding(false)} onAdded={setAdded} />}
    </SettingSection>
  );
}

/** What a machine row says under its name: its connection, and anything blocking its links. */
function machineLine(machine: Machine, fleet: Fleet): string {
  if (machine.status !== "online")
    return machine.status === "auth_failed" || machine.failed
      ? machineProblem(machine.status, !!machine.failed)
      : machineStatus[machine.status].label;
  const links = fleet.links.get(machine.id);
  if (links?.isError) return fleetProblem(links.error);
  const self = fleet.facts.find((entry) => entry.id === machine.id);
  // Whether it lets agents in shows in how the others' links to it fare.
  const closed =
    self &&
    fleet.facts.some((other) => other.id !== machine.id && reach(other, self).kind === "closed");
  const parts = [machine.primary ? "This machine" : "Connected"];
  if (closed) parts.push("lets no agents in");
  return parts.join(" · ");
}

function MachineRow(props: {
  machine: Machine;
  fleet: Fleet;
  onLink(gaps: readonly LinkGap[]): void;
}) {
  const { machine, fleet } = props;
  const missing = unlinkedWith(machine.id, fleet.gaps);
  const gaps = fleet.gaps.filter((gap) => gap.from === machine.id || gap.to === machine.id);
  const online = fleet.machines.filter((entry) => entry.client).length;
  const known = fleet.links.get(machine.id)?.isSuccess;
  return (
    // The whole row opens the machine's page; its Link button sits above that.
    <div
      id={machine.primary ? "host.displayName" : undefined}
      data-fleet-machine=""
      className="group/setting relative flex min-h-(--setting-row-height) items-center gap-3 py-(--setting-row-y)"
    >
      <MachineMark icon={machine.icon} primary={machine.primary} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          to="/settings/remote/$machine"
          params={{ machine: machine.primary ? primaryMachineId : machine.id }}
          className="w-fit rounded-sm text-md text-foreground focus-ring after:absolute after:inset-0 after:content-['']"
        >
          {machine.name}
        </Link>
        <span className="text-xs text-muted-foreground">{machineLine(machine, fleet)}</span>
      </div>
      {missing.length > 0 ? (
        <>
          <span className="hidden text-xs text-muted-foreground @[30rem]:inline">
            Not linked with {listNames(missing.map((id) => fleet.byId(id)?.name ?? "a machine"))}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="relative -mr-2.5"
            disabled={fleet.link.isPending}
            onClick={() => props.onLink(gaps)}
          >
            Link
          </Button>
        </>
      ) : (
        known &&
        online > 1 && <span className="text-xs text-subtle-foreground">Linked with all</span>
      )}
    </div>
  );
}

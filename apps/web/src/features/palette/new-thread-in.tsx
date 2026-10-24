import { FolderSimpleIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { CommandChoices, type CommandChoice } from "@/components/ui/command-choices.tsx";
import {
  machineAwayText,
  rememberMachine,
  rememberedMachine,
  targetMachine,
} from "@/features/home/index.ts";
import { MachineChip, machineChoices } from "@/features/projects/index.ts";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useLayout } from "@/lib/layout.tsx";
import { newThreadOn } from "@/lib/machine-routes.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { useProjectDirectory } from "@/lib/projects.ts";

type Chosen = Pick<Machine, "id" | "name" | "primary">;

/**
 * "New thread in…": the projects by name; choosing one opens a new thread draft there. While more
 * than one machine is online, a chip in the field names the machine whose projects are listed
 * (the one New thread used last, else this one) and lists the machines to choose another.
 */
export function NewThreadIn(props: { onBack: () => void; close(): void }) {
  const machines = useMachines();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const [chosen, setChosen] = useState<Chosen | undefined>(() => {
    const id = targetMachine({}, machines, rememberedMachine(storage));
    return machines.find((each) => each.id === id);
  });
  const [picking, setPicking] = useState(false);
  // This window's daemon is found by being primary: its id becomes its host id once known.
  const found =
    chosen && machines.find((each) => each.id === chosen.id || (chosen.primary && each.primary));
  // A chosen machine that leaves the pool stays chosen, unreachable: a project chosen here never
  // opens on a machine other than the one the chip names.
  const machine: Machine | undefined = chosen
    ? (found ?? { ...chosen, status: "offline", client: undefined })
    : machines[0];
  const online = machines.filter((each) => each.status === "online").length;
  const several = online > 1 || (machine !== undefined && !machine.primary);
  const choices = useMemo(() => machineChoices(machines, { onlineOnly: true }), [machines]);

  if (!machine) return null;
  if (several && picking)
    return (
      <CommandChoices
        fieldLabel="Search machines"
        listLabel="Machines"
        placeholder="New thread on…"
        choices={choices}
        onChoose={(choice) => {
          const next = machines.find((each) => each.id === choice.id);
          if (next) setChosen({ id: next.id, name: next.name, primary: next.primary });
          setPicking(false);
        }}
        onBack={() => setPicking(false)}
        empty="No machines match"
      />
    );
  const chip = several ? (
    <MachineChip name={machine.name} onClick={() => setPicking(true)} />
  ) : undefined;
  return (
    <MachineScope
      key={machine.id}
      machine={machine}
      unavailable={
        <Projects
          choices={none}
          empty={machineAwayText(machine)}
          onBack={props.onBack}
          chip={chip}
        />
      }
    >
      <MachineProjects
        machine={machine}
        chip={chip}
        onBack={props.onBack}
        onChoose={(project) => {
          const on = machine.primary ? undefined : machine.id;
          if (several) rememberMachine(storage, on);
          props.close();
          void navigate(newThreadOn(on, project));
          focusComposerSoon();
        }}
      />
    </MachineScope>
  );
}

const none: readonly CommandChoice[] = [];

/** The chosen machine's projects; rendered under its `MachineScope`, so they are its own. */
function MachineProjects(props: {
  machine: Machine;
  chip: ReactNode;
  onBack(): void;
  onChoose(project: string): void;
}) {
  const directory = useProjectDirectory();
  const choices = useMemo(
    () =>
      directory.projects.map((project): CommandChoice => ({
        id: project.id,
        label: project.name,
        icon: FolderSimpleIcon,
      })),
    [directory.projects],
  );
  const empty = !directory.loaded
    ? "Reading projects…"
    : choices.length
      ? "No projects match"
      : `No projects on ${props.machine.name}`;
  return (
    <Projects
      choices={choices}
      empty={empty}
      onBack={props.onBack}
      chip={props.chip}
      onChoose={props.onChoose}
    />
  );
}

function Projects(props: {
  choices: readonly CommandChoice[];
  empty: ReactNode;
  chip: ReactNode;
  onBack(): void;
  onChoose?(project: string): void;
}) {
  return (
    <CommandChoices
      fieldLabel="Search projects"
      listLabel="Projects"
      placeholder="New thread in…"
      choices={props.choices}
      onChoose={(choice) => props.onChoose?.(choice.id)}
      onBack={props.onBack}
      empty={props.empty}
      trailing={props.chip}
    />
  );
}

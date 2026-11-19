import { ChatCircleIcon, DevicesIcon, FolderPlusIcon, FolderSimpleIcon } from "@ace/icons";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "@/components/project-mark.tsx";
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
import { chatChoice } from "@/lib/chat-choice.ts";
import { CommandShortcut } from "@/components/ui/command.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { useKeys } from "@/lib/keybindings.ts";
import { describeKeys } from "@/lib/keymap.ts";
import { NewThreadGroups, addProjectChoice } from "./new-thread-groups.tsx";

type Chosen = Pick<Machine, "id" | "name" | "primary">;

/** The last row: add a project here, whose new thread draft then opens. */
const addProject = addProjectChoice;
/** The machine list's first row: every machine's projects, as logical projects (ADR 0180). */
const allMachines = "\u0000all-machines";

/*
 * Whether the step lists one machine's projects because the person picked that machine in it
 * last. Absent: with more than one machine, it lists every machine's.
 */
const scopeKey = "ace.palette.newThreadIn";
const Scope = z.object({ machine: z.literal(true).optional() }).catch({});
const pickedMachine = (storage: KeyValueStorage | undefined) =>
  readJson(storage, scopeKey, Scope, {}).machine === true;
const rememberScope = (storage: KeyValueStorage | undefined, machine: boolean) =>
  writeJson(storage, scopeKey, machine ? { machine: true } : {});

/**
 * "New thread in…": a chat with no project first, then the projects by name, then Add
 * project…; choosing a project or the chat opens a new thread draft there. While more than one
 * machine is online, a chip in the field names the machine whose projects are listed (the one
 * New thread used last, else this one) and lists the machines to choose another. Add project
 * from here starts on that machine.
 */
export function NewThreadIn(props: {
  onBack: () => void;
  close(): void;
  /** Add project, on the machine whose projects are listed. */
  onAddProject(machine: Chosen): void;
}) {
  const machines = useMachines();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const [chosen, setChosen] = useState<Chosen | undefined>(() => {
    const id = targetMachine({}, machines, rememberedMachine(storage));
    return machines.find((each) => each.id === id);
  });
  const [picking, setPicking] = useState(false);
  // More than one machine: every machine's projects, until the person picks one machine here.
  const [everywhere, setEverywhere] = useState(
    () => machines.length > 1 && !pickedMachine(storage),
  );
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
  const choices = useMemo(
    () => [
      ...(machines.length > 1
        ? [{ id: allMachines, label: "All machines", icon: DevicesIcon }]
        : []),
      ...machineChoices(machines, { onlineOnly: true }),
    ],
    [machines],
  );

  if (!machine) return null;
  if ((several || everywhere) && picking)
    return (
      <CommandChoices
        key="machines"
        fieldLabel="Search machines"
        listLabel="Machines"
        placeholder="New thread on…"
        choices={choices}
        onChoose={(choice) => {
          if (choice.id === allMachines) {
            setEverywhere(true);
            rememberScope(storage, false);
            setPicking(false);
            return;
          }
          const next = machines.find((each) => each.id === choice.id);
          if (next) setChosen({ id: next.id, name: next.name, primary: next.primary });
          setEverywhere(false);
          rememberScope(storage, true);
          setPicking(false);
        }}
        onBack={() => setPicking(false)}
        empty="No machines match"
        onSwitchMachines={() => setPicking(false)}
        switchLabel="Projects"
      />
    );
  const chip =
    several || everywhere ? (
      <MachineChip
        name={everywhere ? "All machines" : machine.name}
        onClick={() => setPicking(true)}
      />
    ) : undefined;
  const switchMachines = several || everywhere ? () => setPicking(true) : undefined;
  const open = (on: Machine | undefined, project: string) => {
    const host = on && !on.primary ? on.id : undefined;
    if (several) rememberMachine(storage, host);
    props.close();
    void navigate(newThreadOn(host, project));
    focusComposerSoon();
  };
  if (everywhere) {
    const here = machines.find((each) => each.primary) ?? machine;
    return (
      <NewThreadGroups
        machines={machines}
        chip={chip}
        onBack={props.onBack}
        onSwitchMachines={switchMachines}
        onChooseOther={(choice) => {
          if (choice === addProject)
            return props.onAddProject({ id: here.id, name: here.name, primary: here.primary });
          open(here, choice);
        }}
        onChooseCheckout={(checkout) =>
          open(
            machines.find((each) => each.id === checkout.machineId),
            checkout.workspaceId,
          )
        }
      />
    );
  }
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
          onSwitchMachines={switchMachines}
        />
      }
    >
      <MachineProjects
        machine={machine}
        chip={chip}
        onBack={props.onBack}
        onSwitchMachines={switchMachines}
        onChoose={(project) => {
          if (project === addProject)
            return props.onAddProject({
              id: machine.id,
              name: machine.name,
              primary: machine.primary,
            });
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
  onSwitchMachines?: (() => void) | undefined;
  onChoose(project: string): void;
}) {
  const directory = useProjectDirectory();
  const phone = usePhone();
  const addProjectKeys = useKeys("addProject");
  const choices = useMemo(
    () => [
      { id: chatChoice, label: "No project", icon: ChatCircleIcon },
      ...directory.projects.map((project): CommandChoice => ({
        id: project.id,
        label: project.name,
        icon: FolderSimpleIcon,
        mark: <ProjectMark id={project.id} badge={projectBadge(project)} />,
      })),
      {
        id: addProject,
        label: "Add project",
        icon: FolderPlusIcon,
        separatorBefore: true,
        aside: phone ? undefined : (
          <CommandShortcut>{describeKeys(addProjectKeys)}</CommandShortcut>
        ),
      },
    ],
    [directory.projects, phone, addProjectKeys],
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
      onSwitchMachines={props.onSwitchMachines}
      onChoose={props.onChoose}
    />
  );
}

function Projects(props: {
  choices: readonly CommandChoice[];
  empty: ReactNode;
  chip: ReactNode;
  onBack(): void;
  onSwitchMachines?: (() => void) | undefined;
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
      onSwitchMachines={props.onSwitchMachines}
      switchLabel="Machine"
    />
  );
}

import { useMemo, useState } from "react";
import { CommandChoices } from "@/components/ui/command-choices.tsx";
import type { PaletteStart } from "@/lib/layout.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { CloneProjectStep } from "./clone-project-step.tsx";
import { CreateProjectStep } from "./create-project-step.tsx";
import { GithubStep } from "./github-step.tsx";
import { useLandInProject } from "./land.ts";
import { LocalFolderStep } from "./local-folder-step.tsx";
import { MachineChip, machineChoices } from "./machine-step.tsx";
import { projectSources, type AddPage } from "./project-sources.ts";
import { useProjectDialogs } from "./projects-context.ts";

/**
 * Add project, inside the palette: its sources, then the chosen source's step. With more than
 * one machine the machine is chosen first (a chip in each step changes it); everything after
 * works on that machine only. Adding closes the palette and opens a new thread draft in the
 * project.
 */
export function AddProjectFlow(props: {
  page: AddPage;
  attempt: PaletteStart["attempt"];
  onPage(page: AddPage): void;
  onBack: (() => void) | undefined;
  close(): void;
}) {
  const machines = useMachines();
  const { clone } = useProjectDialogs();
  const land = useLandInProject();
  const [chosen, setChosen] = useState<{ id: string; name: string; primary: boolean }>();
  const [picking, setPicking] = useState(machines.length > 1);
  const [cloneUrl, setCloneUrl] = useState<{ machine: string; url: string }>();
  // This window's daemon is found by being primary: its id becomes its host id once known.
  const found =
    chosen && machines.find((each) => each.id === chosen.id || (chosen.primary && each.primary));
  // A chosen machine that leaves the pool stays chosen, unreachable, until another is picked:
  // nothing typed for it may land on a different machine.
  const machine: Machine | undefined = chosen
    ? (found ?? { ...chosen, status: "offline", client: undefined })
    : machines[0];
  const several = machines.length > 1 || (chosen !== undefined && found === undefined);
  const choices = useMemo(() => machineChoices(machines, { onlineOnly: false }), [machines]);

  if (!machine) return null;
  if (several && picking)
    return (
      <CommandChoices
        fieldLabel="Search machines"
        listLabel="Machines"
        placeholder="Add a project on…"
        choices={choices}
        onChoose={(choice) => {
          const next = machines.find((each) => each.id === choice.id);
          if (next) setChosen({ id: next.id, name: next.name, primary: next.primary });
          setPicking(false);
        }}
        onBack={chosen ? () => setPicking(false) : props.onBack}
        empty="No machines match"
      />
    );
  const chip = several ? (
    <MachineChip name={machine.name} onClick={() => setPicking(true)} />
  ) : undefined;

  if (props.page === "add-local")
    return (
      <LocalFolderStep
        key={machine.id}
        machine={machine}
        attempt={machine.primary ? props.attempt : undefined}
        onBack={props.onBack}
        close={props.close}
        trailing={chip}
      />
    );
  if (props.page === "add-create")
    return (
      <CreateProjectStep
        key={machine.id}
        machine={machine}
        onBack={props.onBack}
        trailing={chip}
        onAdded={(result, on) => {
          props.close();
          land(result, "Created", { mode: "thread", machine: on });
        }}
      />
    );
  if (props.page === "add-clone")
    return (
      <CloneProjectStep
        key={`${machine.id}\u0000${cloneUrl?.url ?? ""}`}
        machine={machine}
        clone={clone}
        initialUrl={cloneUrl?.machine === machine.id ? cloneUrl.url : undefined}
        onBack={props.onBack}
        trailing={chip}
        several={several}
      />
    );
  if (props.page === "add-github")
    return (
      <GithubStep
        machine={machine}
        onBack={props.onBack}
        trailing={chip}
        onSelect={(row) => {
          setCloneUrl({ machine: machine.id, url: row.cloneUrl });
          props.onPage("add-clone");
        }}
      />
    );
  return (
    <CommandChoices
      fieldLabel="Search project sources"
      listLabel="Project sources"
      placeholder="Add a project from…"
      choices={projectSources.map((source) => ({
        id: source.page,
        label: source.label,
        icon: source.icon,
      }))}
      onChoose={(choice) => {
        const source = projectSources.find((each) => each.page === choice.id);
        if (source) props.onPage(source.page);
      }}
      onBack={props.onBack}
      empty="No sources match"
      trailing={chip}
    />
  );
}

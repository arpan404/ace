import { DesktopIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { CommandChoices, type CommandChoice } from "@/components/ui/command-choices.tsx";
import type { PaletteStart } from "@/lib/layout.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { CloneProjectStep } from "./clone-project-step.tsx";
import { CreateProjectStep } from "./create-project-step.tsx";
import { GithubStep } from "./github-step.tsx";
import { useLandInProject } from "./land.ts";
import { LocalFolderStep } from "./local-folder-step.tsx";
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
  const choices = useMemo(
    () =>
      machines.map((each): CommandChoice => ({
        id: each.id,
        label: each.name,
        icon: DesktopIcon,
        ...(each.status === "online"
          ? {}
          : {
              aside: (
                <span className="text-xs text-muted-foreground">
                  {machineStatus[each.status].label}
                </span>
              ),
            }),
      })),
    [machines],
  );

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
    <button
      type="button"
      aria-label={`Machine: ${machine.name}`}
      onClick={() => setPicking(true)}
      className="h-6 max-w-40 shrink-0 truncate rounded-sm px-2 text-sm text-muted-foreground focus-ring hover:bg-accent hover:text-foreground"
    >
      {machine.name}
    </button>
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

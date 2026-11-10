import { Activity, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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

/** A machine as the flow remembers it: found again in the pool by id, or by being this one. */
export type ChosenMachine = Pick<Machine, "id" | "name" | "primary">;

/** One step shown on one machine. Its drafts live as long as the flow does. */
interface Slot {
  key: string;
  page: AddPage;
  on: ChosenMachine;
}

/**
 * Add project, inside the palette: its sources, then the chosen source's step. It starts on
 * this machine, or the one New thread in had chosen; with more than one machine a chip in each
 * step (or Ctrl+M anywhere in the flow) lists the machines to change it. Everything after works
 * on that machine only. Adding closes the palette and opens a new thread draft in the project.
 *
 * Every step visited stays mounted, hidden, per machine and source: Back, the machine list and
 * a return to the same machine find what was typed where it was left.
 */
export function AddProjectFlow(props: {
  page: AddPage;
  attempt: PaletteStart["attempt"];
  /** The machine to start on (New thread in's); else this one. */
  machine?: ChosenMachine | undefined;
  onPage(page: AddPage): void;
  onBack: (() => void) | undefined;
  close(): void;
}) {
  const machines = useMachines();
  const { clone } = useProjectDialogs();
  const land = useLandInProject();
  const [chosen, setChosen] = useState<ChosenMachine | undefined>(props.machine);
  const [picking, setPicking] = useState(false);
  const [cloneUrl, setCloneUrl] = useState<{ machine: string; url: string }>();
  const [slots, setSlots] = useState<readonly Slot[]>([]);
  const root = useRef<HTMLDivElement>(null);
  // Only machines that can take a project now make it a choice, as in New thread.
  const online = machines.filter((each) => each.status === "online");
  const resolve = (pick: ChosenMachine): Machine | undefined =>
    machines.find((each) => each.id === pick.id || (pick.primary && each.primary));
  // A chosen machine that leaves the pool stays chosen, unreachable, until another is picked:
  // nothing typed for it may land on a different machine.
  const unreachable = (pick: ChosenMachine): Machine => ({
    ...pick,
    status: "offline",
    client: undefined,
  });
  const found = chosen && resolve(chosen);
  const machine: Machine | undefined = chosen
    ? (found ?? unreachable(chosen))
    : // This machine first; when it's down, the one that can take a project now.
      (online[0] ?? machines[0]);
  // A machine other than this one always shows which, so the chip can change it.
  const several =
    online.length > 1 ||
    (chosen === undefined ? machine?.primary === false : found === undefined || !found.primary);
  const choices = useMemo(() => machineChoices(machines, { onlineOnly: false }), [machines]);

  const current = machine ? `${machine.id}\u0000${props.page}` : undefined;
  if (machine && current && !slots.some((slot) => slot.key === current))
    setSlots([
      ...slots,
      {
        key: current,
        page: props.page,
        on: { id: machine.id, name: machine.name, primary: machine.primary },
      },
    ]);
  const showing = picking && several ? undefined : current;

  // A step shown again keeps its DOM, so its field doesn't autofocus: give it focus back.
  useEffect(() => {
    const shown = [...(root.current?.children ?? [])].find(
      (each) => each instanceof HTMLElement && each.dataset.slot === showing,
    );
    if (!shown || shown.contains(document.activeElement)) return;
    shown.querySelector<HTMLElement>("input:not([type=hidden]), textarea")?.focus();
  }, [showing]);

  if (!machine) return null;
  const pickMachine = several ? () => setPicking(true) : undefined;
  const chip = several ? (
    <MachineChip name={machine.name} onClick={() => setPicking(true)} />
  ) : undefined;

  // Ctrl+M opens the machines from whatever has focus in the flow (⌘M would minimize the
  // window); a list that handles it itself has already claimed it.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!several || event.defaultPrevented) return;
    if (event.key.toLowerCase() !== "m" || !event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    setPicking((now) => !now);
  };

  const step = (slot: Slot) => {
    const on = resolve(slot.on) ?? unreachable(slot.on);
    const trailing = slot.key === current ? chip : undefined;
    if (slot.page === "add-local")
      return (
        <LocalFolderStep
          machine={on}
          attempt={on.primary ? props.attempt : undefined}
          onBack={props.onBack}
          close={props.close}
          trailing={trailing}
        />
      );
    if (slot.page === "add-create")
      return (
        <CreateProjectStep
          machine={on}
          onBack={props.onBack}
          trailing={trailing}
          onAdded={(result, there) => {
            props.close();
            land(result, "Created", { mode: "thread", machine: there });
          }}
        />
      );
    if (slot.page === "add-clone") {
      const url = cloneUrl?.machine === on.id ? cloneUrl.url : undefined;
      return (
        // A repository chosen in GitHub starts the clone's form over with its address.
        <CloneProjectStep
          key={url ?? ""}
          machine={on}
          clone={clone}
          initialUrl={url}
          onBack={props.onBack}
          trailing={trailing}
          several={several}
        />
      );
    }
    if (slot.page === "add-github")
      return (
        <GithubStep
          machine={on}
          onBack={props.onBack}
          trailing={trailing}
          onSelect={(row) => {
            setCloneUrl({ machine: on.id, url: row.cloneUrl });
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
        trailing={trailing}
        onSwitchMachines={pickMachine}
        switchLabel="Machine"
      />
    );
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Ctrl+M from the fields inside, which keep their own roles
    <div ref={root} className="contents" onKeyDown={onKeyDown}>
      {showing === undefined && (
        // Its own list with its own search: nothing typed here filters a step's list.
        <CommandChoices
          key="machines"
          fieldLabel="Search machines"
          listLabel="Machines"
          placeholder="Add a project on…"
          choices={choices}
          onChoose={(choice) => {
            const next = machines.find((each) => each.id === choice.id);
            if (next) setChosen({ id: next.id, name: next.name, primary: next.primary });
            setPicking(false);
          }}
          onBack={() => setPicking(false)}
          empty="No machines match"
          onSwitchMachines={() => setPicking(false)}
          switchLabel="Sources"
        />
      )}
      {slots.map((slot) => (
        <Activity key={slot.key} mode={slot.key === showing ? "visible" : "hidden"}>
          <div data-slot={slot.key} className="contents">
            {step(slot)}
          </div>
        </Activity>
      ))}
    </div>
  );
}

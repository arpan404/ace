import { CaretDownIcon } from "@phosphor-icons/react";
import { useMemo, useRef } from "react";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { Machine } from "@/lib/machines.ts";
import { useManyDevices } from "../row-parts.tsx";
import { useNewThreadMachines, type NewThreadMachines } from "./machine-choice.ts";
import { moveResolver } from "./machine-move.ts";

/**
 * The machine a new thread runs on, as a line under the page's question ("on Build server"),
 * shown only while more than one machine is connected. While more than one is online the name
 * is a picker: Enter, Space or a click opens the list; arrows move and Enter picks. A machine
 * that isn't connected shows why and can't be picked. Picking one moves the whole page to it:
 * its projects, models, branches and access. The project and message go along: that machine's
 * own copy of the repository when it has one, else the project, copied there on send.
 */
export function MachineLine(props: {
  returnFocus(): HTMLElement | null;
  /** The project (`chatChoice` for a chat) and draft that go along to another machine. */
  project: string;
  /** The machine the project is on, when it isn't on this one yet. */
  from?: string | undefined;
  draft: { host: string; key: string };
}) {
  const host = useMachineIdentity();
  const many = useManyDevices();
  const choice = useNewThreadMachines();
  const online = choice?.machines.filter((machine) => machine.status === "online").length ?? 0;
  if (choice !== undefined && (online > 1 || !choice.current.primary))
    return (
      <p className={line}>
        on{" "}
        <MachineMenu
          choice={choice}
          project={props.project}
          from={props.from}
          draft={props.draft}
          returnFocus={props.returnFocus}
        />
      </p>
    );
  if (!many) return null;
  return <p className={line}>on {host.name}</p>;
}

const line = "-mt-4 mb-6 px-1 text-center text-sm text-muted-foreground";

function MachineMenu(props: {
  choice: NewThreadMachines;
  project: string;
  from: string | undefined;
  draft: { host: string; key: string };
  returnFocus(): HTMLElement | null;
}) {
  const { machines, current, choose } = props.choice;
  const { storage } = useLayout();
  const moving = useRef(false);
  const home = props.from ? machines.find((each) => each.id === props.from) : current;
  // Where the project lands on each machine, asked as the menu opens so a pick moves at once.
  const moves = useMemo(
    () => moveResolver(storage, props.project, home),
    // A new client for the machine it is on (a reconnect) asks again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `home` is read through its id and client.
    [storage, props.project, home?.id, home?.client],
  );
  const askAhead = () => {
    for (const machine of machines)
      if (machine.id !== current.id && machine.status === "online") void moves.resolve(machine);
  };
  // The project goes along: the other machine's own copy of it, or this one, to copy on send.
  const move = async (next: Machine) => {
    if (moving.current) return;
    moving.current = true;
    try {
      choose(next, { ...(await moves.resolve(next)), draft: props.draft });
    } finally {
      moving.current = false;
    }
  };
  return (
    <Menu onOpenChange={(open) => open && askAhead()}>
      <Tip label="Change machine" side="top">
        <MenuTrigger
          onPointerEnter={askAhead}
          onFocus={askAhead}
          aria-label={`Machine: ${current.name}`}
          className="inline-flex max-w-full items-center gap-1 rounded-sm text-foreground underline decoration-muted-foreground/60 decoration-dotted decoration-2 underline-offset-[0.25em] transition-colors duration-(--motion-fast) focus-ring hover:decoration-foreground data-popup-open:decoration-foreground"
        >
          <span className="truncate">{current.name}</span>
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </MenuTrigger>
      </Tip>
      <MenuContent
        side="bottom"
        align="center"
        aria-label="Machines"
        finalFocus={props.returnFocus}
      >
        <MenuRadioGroup
          value={current.id}
          onValueChange={(id: unknown) => {
            const next = machines.find((machine) => machine.id === id);
            if (next && next.id !== current.id && next.status === "online") void move(next);
          }}
        >
          {machines.map((machine) => (
            <MenuRadioItem
              key={machine.id}
              value={machine.id}
              disabled={machine.status !== "online"}
              aria-label={
                machine.status === "online"
                  ? machine.name
                  : `${machine.name}, ${machineStatus[machine.status].label}`
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <MachineMark icon={machine.icon} primary={machine.primary} />
                <span className="truncate">{machine.name}</span>
                {machine.status !== "online" && (
                  <span className="text-xs text-subtle-foreground">
                    {machineStatus[machine.status].label}
                  </span>
                )}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

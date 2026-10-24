import { CaretDownIcon } from "@phosphor-icons/react";
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
import { useManyDevices } from "../row-parts.tsx";
import { useNewThreadMachines, type NewThreadMachines } from "./machine-choice.ts";

/**
 * The machine a new thread runs on, as a line under the page's question ("on Build server"),
 * shown only while more than one machine is connected. While more than one is online the name
 * is a picker: Enter, Space or a click opens the list; arrows move and Enter picks. A machine
 * that isn't connected shows why and can't be picked. Picking one moves the whole page to it:
 * its projects, models, branches and access.
 */
export function MachineLine(props: { returnFocus(): HTMLElement | null }) {
  const host = useMachineIdentity();
  const many = useManyDevices();
  const choice = useNewThreadMachines();
  const online = choice?.machines.filter((machine) => machine.status === "online").length ?? 0;
  if (choice !== undefined && (online > 1 || !choice.current.primary))
    return (
      <p className={line}>
        on <MachineMenu choice={choice} returnFocus={props.returnFocus} />
      </p>
    );
  if (!many) return null;
  return <p className={line}>on {host.name}</p>;
}

const line = "-mt-4 mb-6 px-1 text-center text-sm text-muted-foreground";

function MachineMenu(props: { choice: NewThreadMachines; returnFocus(): HTMLElement | null }) {
  const { machines, current, choose } = props.choice;
  return (
    <Menu>
      <Tip label="Change machine" side="top">
        <MenuTrigger
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
            if (next && next.id !== current.id && next.status === "online") choose(next);
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

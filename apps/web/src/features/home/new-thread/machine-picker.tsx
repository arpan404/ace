import { CaretDownIcon } from "@phosphor-icons/react";
import { MachineLabel, MachineMark } from "@/components/ui/machine-label.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { composerStrip } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { machineStatus } from "@/lib/machine-status.ts";
import type { NewThreadMachines } from "./machine-choice.ts";

/**
 * The machine a new thread runs on, in the composer's top strip. Enter, Space or a click opens
 * the list; arrows move and Enter picks. A machine that isn't connected shows why and can't be
 * picked. Picking one moves the whole page to it: its projects, models, branches and access.
 */
export function MachinePicker(props: { choice: NewThreadMachines; compact: boolean }) {
  const { machines, current, choose } = props.choice;
  return (
    <Menu>
      <Tip label={`Runs on ${current.name}`} side="top">
        <MenuTrigger
          aria-label={`Machine: ${current.name}`}
          className={cn(composerStrip, "max-w-48 shrink-0 text-foreground")}
        >
          {props.compact ? (
            <MachineMark icon={current.icon} primary={current.primary} />
          ) : (
            <MachineLabel name={current.name} icon={current.icon} primary={current.primary} />
          )}
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" align="start" aria-label="Machines">
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

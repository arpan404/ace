import { CaretDownIcon, LaptopIcon } from "@phosphor-icons/react";
import type { CommandChoice } from "@/components/ui/command-choices.tsx";
import { MachineMark, machineIcons, defaultMachineIcon } from "@/components/ui/machine-label.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import type { Machine } from "@/lib/machines.ts";

/*
 * The machine part of a palette step that works on one of several machines (Add project, New
 * thread in…): the machines as rows to choose from, and the chip in the step's field that names
 * the chosen one and opens that list again. The chip is a bordered button with the machine's
 * mark and a caret so it reads as a picker; Tab reaches it and Ctrl+M flips straight to the
 * machine list without leaving the field.
 */

/** The glyph for a machine row: its own mark when set, else laptop here, server away. */
function machineGlyph(machine: Machine) {
  const kind = machine.icon?.kind ?? defaultMachineIcon(machine.primary).kind;
  return machineIcons.find((entry) => entry.kind === kind)?.glyph ?? LaptopIcon;
}

/** Each machine as a row, its status at the right while it isn't connected. */
export function machineChoices(
  machines: readonly Machine[],
  options: { onlineOnly: boolean },
): CommandChoice[] {
  return machines.map((each): CommandChoice => {
    const icon = machineGlyph(each);
    if (each.status === "online") return { id: each.id, label: each.name, icon };
    return {
      id: each.id,
      label: each.name,
      icon,
      disabled: options.onlineOnly,
      spoken: `${each.name}, ${machineStatus[each.status].label}`,
      aside: (
        <span className="text-xs text-muted-foreground">{machineStatus[each.status].label}</span>
      ),
    };
  });
}

/** The chosen machine's name in the step's field; choosing it lists the machines again. */
export function MachineChip(props: {
  name: string;
  icon?: Machine["icon"];
  primary?: boolean | undefined;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={`Machine: ${props.name}`}
      title="Change machine (Ctrl+M)"
      onClick={props.onClick}
      className="flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md border border-border px-1.5 text-sm font-medium text-foreground focus-ring hover:bg-accent hover:text-accent-foreground"
    >
      <MachineMark icon={props.icon} primary={props.primary} />
      <span className="truncate">{props.name}</span>
      <CaretDownIcon aria-hidden size={12} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

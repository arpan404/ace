import { DesktopIcon } from "@phosphor-icons/react";
import type { CommandChoice } from "@/components/ui/command-choices.tsx";
import { machineStatus } from "@/lib/machine-status.ts";
import type { Machine } from "@/lib/machines.ts";

/*
 * The machine part of a palette step that works on one of several machines (Add project, New
 * thread in…): the machines as rows to choose from, and the chip in the step's field that names
 * the chosen one and opens that list again.
 */

/** Each machine as a row, its status at the right while it isn't connected. */
export function machineChoices(
  machines: readonly Machine[],
  options: { onlineOnly: boolean },
): CommandChoice[] {
  return machines.map((each): CommandChoice => {
    if (each.status === "online") return { id: each.id, label: each.name, icon: DesktopIcon };
    return {
      id: each.id,
      label: each.name,
      icon: DesktopIcon,
      disabled: options.onlineOnly,
      spoken: `${each.name}, ${machineStatus[each.status].label}`,
      aside: (
        <span className="text-xs text-muted-foreground">{machineStatus[each.status].label}</span>
      ),
    };
  });
}

/** The chosen machine's name in the step's field; choosing it lists the machines again. */
export function MachineChip(props: { name: string; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label={`Machine: ${props.name}`}
      onClick={props.onClick}
      className="h-6 max-w-40 shrink-0 truncate rounded-sm px-2 text-sm text-muted-foreground focus-ring hover:bg-accent hover:text-foreground"
    >
      {props.name}
    </button>
  );
}

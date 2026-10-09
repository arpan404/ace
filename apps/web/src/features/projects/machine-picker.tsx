import { useRef, type KeyboardEvent } from "react";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { cn } from "@/lib/cn.ts";
import type { Machine, MachineStatus } from "@/lib/machines.ts";

const statusLabel: Record<MachineStatus, string> = {
  online: "connected",
  connecting: "connecting",
  offline: "offline",
  auth_failed: "needs pairing again",
};
const statusDot: Record<MachineStatus, string> = {
  online: "bg-status-done",
  connecting: "bg-status-waiting",
  offline: "bg-subtle-foreground",
  auth_failed: "bg-status-failed",
};

/** The machine after `id`, wrapping: ⌘M. */
export function nextMachine(machines: readonly Machine[], id: string): Machine | undefined {
  const at = machines.findIndex((machine) => machine.id === id);
  return machines[(at + 1) % machines.length];
}

/**
 * Which machine Add project works on, when there is more than one: a radio group (arrows move
 * between machines, Tab leaves) with each machine's live status. An offline machine can be
 * chosen; the tabs below say it isn't connected rather than reaching another machine.
 */
export function MachinePicker(props: {
  machines: readonly Machine[];
  value: string;
  onValue(id: string): void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    props.onValue(id);
    group.current?.querySelector<HTMLElement>(`[data-machine="${CSS.escape(id)}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = props.machines.findIndex((machine) => machine.id === props.value);
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const count = props.machines.length;
    const next = props.machines[(at + step + count) % count];
    if (next) select(next.id);
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="text-sm text-subtle-foreground">
        On
      </span>
      <div
        ref={group}
        role="radiogroup"
        aria-label="Machine"
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-wrap items-center gap-1"
      >
        {props.machines.map((machine, index) => {
          const checked = machine.id === props.value;
          // With the chosen machine gone, the group is still one Tab stop.
          const none = !props.machines.some((each) => each.id === props.value);
          return (
            <button
              key={machine.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`${machine.name}, ${statusLabel[machine.status]}`}
              data-machine={machine.id}
              tabIndex={checked || (none && index === 0) ? 0 : -1}
              onClick={() => select(machine.id)}
              className={cn(
                "inline-flex h-7 max-w-48 items-center gap-1.5 rounded-sm px-2 text-sm font-medium text-muted-foreground outline-none transition-[color,background-color,box-shadow] duration-(--dur-1)",
                "hover:text-foreground focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_70%,transparent)]",
                checked && "bg-foreground/8 text-foreground",
              )}
            >
              <MachineLabel name={machine.name} icon={machine.icon} />
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", statusDot[machine.status])}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { HairlineRow, RowAction, RowGroup, StateWords } from "@/components/hairline-row.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import type { Machine } from "@/lib/machines.ts";

/**
 * Turning a machine off or on in this browser or desktop app (ADR 0115): off, it stays listed,
 * paired and signed in, but nothing here connects to it and its threads are hidden. Only this
 * device changes; the machine itself is never told. This window's own daemon has no switch.
 */
export function useMachineSwitch(machine: Machine) {
  const pool = useMachinePool();
  if (!pool || machine.primary) return undefined;
  const off = machine.status === "off";
  return {
    off,
    label: off ? "Turn on" : "Turn off",
    toggle: () => (off ? pool.turnOn(machine.id) : pool.turnOff(machine.id)),
  };
}

/** The machine page's row for it: one sentence and one action. */
export function MachineOnHere(props: { machine: Machine }) {
  const toggle = useMachineSwitch(props.machine);
  if (!toggle) return null;
  return (
    <RowGroup label="On this device" anchor="on-this-device">
      <HairlineRow
        id="machine.onThisDevice"
        title={toggle.off ? "Off" : "On"}
        sub={
          <StateWords tone={toggle.off ? "off" : "on"}>
            {toggle.off
              ? "Nothing here connects to it, and its threads are hidden. It stays paired."
              : "This device connects to it and shows its threads."}
          </StateWords>
        }
        actions={
          <RowAction
            className={toggle.off ? "text-foreground" : undefined}
            aria-label={`${toggle.label} ${props.machine.name} on this device`}
            onClick={toggle.toggle}
          >
            {toggle.label}
          </RowAction>
        }
      />
    </RowGroup>
  );
}

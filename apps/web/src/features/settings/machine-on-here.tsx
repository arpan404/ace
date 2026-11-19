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

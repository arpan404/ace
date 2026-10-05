import type { MachinePool } from "@ace/client-worker/machines";
import { createContext, useContext } from "react";

/*
 * The client-owned machine pool (ADR 0059), when this window connects to more than its own
 * daemon. Only the context lives here, so the first paint carries no pool code: screens that
 * target a machine read it through `useMachines` (`lib/machines.ts`).
 */
const MachinePoolContext = createContext<MachinePool | undefined>(undefined);

export const MachinePoolProvider = MachinePoolContext.Provider;

/** The window's machine pool, or undefined when it talks to one daemon. */
export function useMachinePool(): MachinePool | undefined {
  return useContext(MachinePoolContext);
}

import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, use, useMemo, type ReactNode } from "react";
import type { Machine } from "@/lib/machines.ts";

/*
 * Which machine's Spade a view talks to (ADR 0127: each bot runs on a machine the person picks).
 * Below `SpadeMachineScope`, `useSpadeClient()` is that machine's client, so Spade's requests and
 * live streams go through its daemon. Only Spade's own views read it: the app's client stays this
 * window's (the shell renders its rail and panel inside each screen), and query keys carry the
 * machine's key so nothing read from one machine shows for another.
 */

export interface SpadeMachine {
  /** `primary` for this window's own machine, else the machine's host id. */
  key: string;
  name: string;
  primary: boolean;
}

interface Scope extends SpadeMachine {
  /** Another machine's client; undefined for this window's own. */
  client: ClientApi | undefined;
}

const Current = createContext<Scope>({
  key: "primary",
  name: "This machine",
  primary: true,
  client: undefined,
});

export const useSpadeMachine = (): SpadeMachine => use(Current);

/** The client Spade's requests go through: the scoped machine's, else this window's. */
export function useSpadeClient(): ClientApi {
  const app = useClient();
  return use(Current).client ?? app;
}

/** The key a machine's Spade reads are cached under. */
export const spadeMachineKey = (machine: Pick<Machine, "id" | "primary">) =>
  machine.primary ? "primary" : machine.id;

export function spadeMachineOf(machine: Machine): SpadeMachine {
  return { key: spadeMachineKey(machine), name: machine.name, primary: machine.primary };
}

/** Renders `children` against `machine`'s Spade; `unavailable` while it is offline. */
export function SpadeMachineScope(props: {
  machine: Machine;
  unavailable?: ReactNode;
  children: ReactNode;
}) {
  const { machine } = props;
  const value = useMemo(
    (): Scope => ({
      ...spadeMachineOf(machine),
      client: machine.primary ? undefined : machine.client,
    }),
    [machine],
  );
  if (!machine.primary && !machine.client) return props.unavailable ?? null;
  return <Current value={value}>{props.children}</Current>;
}

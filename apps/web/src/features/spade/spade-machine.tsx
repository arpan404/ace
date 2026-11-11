import { ClientProvider, useNotifyBatch } from "@ace/client-react";
import { createContext, use, useMemo, type ReactNode } from "react";
import type { Machine } from "@/lib/machines.ts";

/*
 * Which machine's Spade a view talks to (ADR 0127: each bot runs on a machine the person picks).
 * Below `SpadeMachineScope` `useClient()` is that machine's client, so Spade's requests and live
 * streams go through its daemon; query keys carry the machine's key so nothing read from one
 * machine shows for another.
 */

export interface SpadeMachine {
  /** `primary` for this window's own machine, else the machine's host id. */
  key: string;
  name: string;
  primary: boolean;
}

export const thisSpadeMachine: SpadeMachine = {
  key: "primary",
  name: "This machine",
  primary: true,
};

const Current = createContext<SpadeMachine>(thisSpadeMachine);

export const useSpadeMachine = (): SpadeMachine => use(Current);

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
  const batch = useNotifyBatch();
  const { machine } = props;
  const value = useMemo(() => spadeMachineOf(machine), [machine]);
  if (machine.primary) return <Current value={value}>{props.children}</Current>;
  if (!machine.client) return props.unavailable ?? null;
  return (
    <ClientProvider client={machine.client} batch={batch}>
      <Current value={value}>{props.children}</Current>
    </ClientProvider>
  );
}

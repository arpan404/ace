import { useMemo } from "react";
import { useScopedMachine } from "./machines.ts";

/*
 * Addresses of work on another of the person's machines (ADR 0102). A thread or New thread on
 * another machine is the same route with `?machine=<hostId>`; the route renders under that
 * machine's client (`MachineScope`). No `machine` means this window's own daemon.
 */

/** Link or `navigate` options for a thread; `machine` is a host id, undefined for this window's. */
export function threadOn(machine: string | undefined, threadId: string) {
  return {
    to: "/t/$threadId",
    params: { threadId },
    search: machine ? { machine } : {},
  } as const;
}

/**
 * Link or `navigate` options for New thread on a machine, in one of its projects. `from` names
 * the machine the project is on when it isn't on this one yet: sending copies it here first.
 */
export function newThreadOn(
  machine: string | undefined,
  project?: string | undefined,
  from?: string | undefined,
) {
  return {
    to: "/new",
    search: {
      ...(project ? { project } : {}),
      ...(from ? { from } : {}),
      ...(machine ? { machine } : {}),
    },
  } as const;
}

/**
 * The `?machine=` a link inside a view on another machine carries, so a subagent or a linked
 * thread opens on the same machine. Empty on this window's own daemon.
 */
export function useMachineSearch(): { machine?: string } {
  const machine = useScopedMachine()?.id;
  return useMemo(() => (machine ? { machine } : {}), [machine]);
}

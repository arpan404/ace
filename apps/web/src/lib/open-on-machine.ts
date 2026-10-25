import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { newThreadOn, threadOn } from "./machine-routes.ts";
import { useMachines } from "./machines.ts";

/** Something that exists on one machine: a thread there, or else its project. */
export interface MachineTarget {
  hostId: string;
  workspaceId?: string | undefined;
  threadId?: string | undefined;
}

/**
 * How "Open" reaches work on a machine (ADR 0101): every transfer's Open goes through here, to
 * the thread (or New thread in the project) on that machine (ADR 0102). Undefined when the
 * machine isn't one this window knows, and Open isn't offered.
 */
export function useOpenOnMachine(): (target: MachineTarget) => (() => void) | undefined {
  const navigate = useNavigate();
  const machines = useMachines();
  return useCallback(
    (target) => {
      const machine = machines.find((each) => each.id === target.hostId);
      if (!machine) return undefined;
      const on = machine.primary ? undefined : machine.id;
      const { threadId, workspaceId } = target;
      if (threadId) return () => void navigate(threadOn(on, threadId));
      if (workspaceId) return () => void navigate(newThreadOn(on, workspaceId));
      return undefined;
    },
    [navigate, machines],
  );
}

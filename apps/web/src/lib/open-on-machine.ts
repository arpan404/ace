import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { usePrimaryMachine } from "./machines.ts";

/** Something that exists on one machine: a thread there, or else its project. */
export interface MachineTarget {
  hostId: string;
  workspaceId?: string | undefined;
  threadId?: string | undefined;
}

/**
 * How "Open" reaches work on a machine (ADR 0099): every transfer's Open goes through here.
 * Returns the action, or undefined when this window can't show that machine's work, and Open
 * isn't offered. This window shows its own machine's threads and projects; another machine's
 * open here once the window can route to them.
 */
export function useOpenOnMachine(): (target: MachineTarget) => (() => void) | undefined {
  const navigate = useNavigate();
  const own = usePrimaryMachine();
  return useCallback(
    (target) => {
      if (target.hostId !== own.id) return undefined;
      const { threadId, workspaceId } = target;
      if (threadId) return () => void navigate({ to: "/t/$threadId", params: { threadId } });
      if (workspaceId) return () => void navigate({ to: "/new", search: { project: workspaceId } });
      return undefined;
    },
    [navigate, own.id],
  );
}

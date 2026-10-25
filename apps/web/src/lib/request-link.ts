import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useMachineSearch } from "./machine-routes.ts";

/**
 * Takes the person to a pending request in its thread's composer strip, where it is answered:
 * the thread opens on it (`?item=`), as a notification's link does.
 */
export function useOpenRequest(): (threadId: string, interactionId: string) => void {
  const navigate = useNavigate();
  const machine = useMachineSearch();
  return useCallback(
    (threadId: string, interactionId: string) =>
      void navigate({
        to: "/t/$threadId",
        params: { threadId },
        search: { item: interactionId, ...machine },
      }),
    [navigate, machine],
  );
}

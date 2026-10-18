import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Takes the person to a pending request in its thread's composer strip, where it is answered:
 * the thread opens on it (`?item=`), as a notification's link does.
 */
export function useOpenRequest(): (threadId: string, interactionId: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (threadId: string, interactionId: string) =>
      void navigate({ to: "/t/$threadId", params: { threadId }, search: { item: interactionId } }),
    [navigate],
  );
}

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { chatChoice } from "@/lib/chat-choice.ts";

/**
 * New chat: New thread with no project, at once (ADR 0099). The page makes the hidden chat
 * project as it opens; nothing asks which project.
 */
export function useNewChat(): () => void {
  const navigate = useNavigate();
  return useCallback(
    () => void navigate({ to: "/new", search: { project: chatChoice } }),
    [navigate],
  );
}

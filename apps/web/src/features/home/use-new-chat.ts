import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { chatChoice } from "@/lib/chat-choice.ts";
import { newThreadOn } from "@/lib/machine-routes.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useChatsDevice } from "./device-filter-state.ts";

/**
 * New chat: New thread with no project, at once (ADR 0099). It starts on this machine unless the
 * Chats panel is narrowed to devices without it, then on the first of those (ADR 0102); the page's "on <device>" line still
 * moves it before sending. The page makes the hidden chat project on that machine as it opens;
 * nothing asks which project.
 */
export function useNewChat(): () => void {
  const navigate = useNavigate();
  const device = useChatsDevice();
  const own = usePrimaryMachine().id;
  const machine = device && !device.includes(own) ? device[0] : undefined;
  return useCallback(() => void navigate(newThreadOn(machine, chatChoice)), [navigate, machine]);
}

import { useClient } from "@ace/client-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useToast } from "@/components/ui/toast.tsx";
import { undoWindowMs } from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { dismissSend, restoreSend } from "../composer/dismissed-sends.ts";
import type { SendPayload } from "../composer/returned-draft.ts";
import { dismissWorktreeStart } from "../worktree/use-worktree-creation.ts";

/**
 * Discarding a message that wasn't sent: gone at once from the thread and the sidebar, with
 * Undo (the toast's button or ⌘Z) putting it back. A new thread's worktree start is forgotten
 * on the daemon only once the Undo has gone unused, so an Undo never brings back a start
 * without its progress. Leaves the page of a new thread that was never made.
 */
export function useDiscardSend() {
  const client = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const { storage } = useLayout();
  return (commandId: string, payload: SendPayload | undefined) => {
    const route = `/t/pending:${commandId}`;
    const open = decodeURIComponent(router.state.location.pathname).startsWith(route);
    dismissSend(storage, commandId);
    if (open) void navigate({ to: "/", replace: true });
    let undone = false;
    toast.add({
      title: "Message discarded",
      timeout: undoWindowMs,
      undo: () => {
        undone = true;
        restoreSend(storage, commandId);
      },
      // Undo runs before its toast closes, so a used Undo never forgets the start.
      onClose: () => {
        if (undone) return;
        if (payload?.type === "thread.create" && payload.mode === "worktree")
          dismissWorktreeStart(client, commandId);
      },
    });
  };
}

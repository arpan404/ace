import { useClient } from "@ace/client-react";
import type { KeyValueStorage } from "@ace/ui-core";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { chatChoice } from "@/lib/chat-choice.ts";
import { undoWindowMs } from "@/features/organize/index.ts";
import { readDraft, writeDraft } from "@/features/thread/index.ts";
import { discardPreparation } from "./discard-preparation.ts";
import { savePreparation, type Preparation } from "./preparations.ts";

const refused =
  "Couldn't discard the draft on this device. Your saved work and files are kept. Free space and try again.";

/**
 * Discarding a draft row: gone at once, with Undo (the toast's button or ⌘Z) putting the row
 * and its message back. The daemon's draft scope (its uploaded files) is released only once
 * the Undo has gone unused, so an Undo never brings back a draft without its files. Returns
 * the refusal to show when this device couldn't discard it.
 */
export function useDiscardDraft(storage: KeyValueStorage | undefined, host: string) {
  const client = useClient();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const directory = useProjectDirectory();
  // Another machine's draft (under its MachineScope) reopens on that machine.
  const machine = useMachineSearch();
  return (key: string, row: Preparation): string | undefined => {
    const content = readDraft(storage, key);
    if (!discardPreparation(storage, host, key)) return refused;
    // Remount an open preparation so its in-memory content cannot recreate the discarded row,
    // or, after Undo, so it shows the content put back.
    const remount = (project: string) =>
      void navigate({
        to: "/new",
        search: (previous) => ({
          ...machine,
          project,
          skill: row.skill,
          issue: row.issue,
          pullRequest: row.pullRequest,
          discard: (previous.discard ?? 0) + 1,
        }),
      });
    // Discarding the saved work also leaves a removed project's recovery page.
    remount(
      !directory.loaded || directory.projects.some((project) => project.id === row.project)
        ? row.project
        : chatChoice,
    );
    let undone = false;
    const release = () => {
      if (undone || !row.draftId) return;
      void client
        .request({
          type: "context.request",
          operation: { op: "draft.release", draftId: row.draftId },
        })
        .catch(() => {
          // The unreferenced scope expires even when this device cannot release it.
        });
    };
    toast.add({
      title: "Draft discarded",
      timeout: undoWindowMs,
      undo: () => {
        undone = true;
        const restored =
          writeDraft(storage, key, content) &&
          savePreparation(storage, host, key, { ...row, discardRecovery: undefined });
        if (!restored) toast.error({ title: "Couldn't bring the draft back" });
        else if (router.state.location.pathname === "/new") remount(row.project);
      },
      // Undo runs before its toast closes, so a used Undo never releases.
      onClose: release,
    });
    return undefined;
  };
}

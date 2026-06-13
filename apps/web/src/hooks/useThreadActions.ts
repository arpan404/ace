import { ProjectId, ThreadId } from "@ace/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { getFallbackThreadIdAfterDelete } from "../lib/sidebar";
import { reportBackgroundError } from "../lib/async";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "./useHandleNewThread";
import { resolveConnectionForProjectId } from "../lib/connectionRouting";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  getWorktreeLinkedThreadIds,
  isWorktreeThreadSessionActive,
  normalizeWorktreePath,
} from "../worktreeCleanup";
import { toastManager } from "../components/ui/toast";
import type { SidebarThreadSummary, Thread } from "../types";
import { useSetting } from "./useSettings";

type DeleteThreadOptions = {
  readonly deletedThreadIds?: ReadonlySet<ThreadId>;
  readonly worktreeRemovalPrompt?: "prompt-if-orphaned" | "skip";
};

type DeleteWorktreeAndRelatedDataInput = {
  readonly connectionUrl?: string | null;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly skipConfirmation?: boolean;
  readonly suppressSuccessToast?: boolean;
  readonly worktreePath: string;
};

type ThreadActionEntry = Pick<
  Thread | SidebarThreadSummary,
  "createdAt" | "id" | "projectId" | "session" | "title" | "updatedAt" | "worktreePath"
>;

function getThreadActionEntries(input: {
  readonly sidebarThreadsById: Readonly<Record<string, SidebarThreadSummary>>;
  readonly threads: readonly Thread[];
}): ThreadActionEntry[] {
  const entriesById = new Map<ThreadId, ThreadActionEntry>();
  for (const sidebarThread of Object.values(input.sidebarThreadsById)) {
    entriesById.set(sidebarThread.id, sidebarThread);
  }
  for (const thread of input.threads) {
    entriesById.set(thread.id, thread);
  }
  return [...entriesById.values()];
}

function getProjectThreadActionEntries(input: {
  readonly projectId: ProjectId;
  readonly sidebarThreadsById: Readonly<Record<string, SidebarThreadSummary>>;
  readonly threads: readonly Thread[];
}): ThreadActionEntry[] {
  return getThreadActionEntries(input).filter((thread) => thread.projectId === input.projectId);
}

function clearDraftsForDeletedWorktree(rawWorktreePath: string) {
  const worktreePath = normalizeWorktreePath(rawWorktreePath);
  if (!worktreePath) return;

  const draftStore = useComposerDraftStore.getState();
  const draftThreadIds = Object.entries(draftStore.draftThreadsByThreadId).flatMap(
    ([threadId, draftThread]) =>
      normalizeWorktreePath(draftThread.worktreePath) === worktreePath
        ? [ThreadId.makeUnsafe(threadId)]
        : [],
  );

  for (const draftThreadId of draftThreadIds) {
    draftStore.clearDraftThread(draftThreadId);
  }
}

export function useThreadActions() {
  const sidebarThreadSortOrder = useSetting("sidebarThreadSortOrder");
  const confirmThreadDelete = useSetting("confirmThreadDelete");
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const archiveThread = async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
    if (!thread) return;
    if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
      throw new Error("Cannot archive a running thread.");
    }

    await api.orchestration.dispatchCommand({
      type: "thread.archive",
      commandId: newCommandId(),
      threadId,
    });

    if (routeThreadId === threadId) {
      await handleNewThread(thread.projectId);
    }
  };

  const unarchiveThread = async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId,
    });
  };

  const deleteThread = useCallback(
    async (threadId: ThreadId, opts: DeleteThreadOptions = {}) => {
      const api = readNativeApi();
      if (!api) return;
      const { projects, sidebarThreadsById, threads } = useStore.getState();
      const threadEntries = getThreadActionEntries({ sidebarThreadsById, threads });
      const thread = threadEntries.find((entry) => entry.id === threadId);
      if (!thread) return;
      const threadProject = projects.find((project) => project.id === thread.projectId);
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threadEntries.filter((entry) => entry.id === threadId || !deletedIds.has(entry.id))
          : threadEntries;
      const orphanedWorktreePath =
        opts.worktreeRemovalPrompt === "skip"
          ? null
          : getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const isWorktreeInUse = isWorktreeThreadSessionActive(thread);
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        !isWorktreeInUse &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));
      if (canDeleteWorktree && isWorktreeInUse) {
        toastManager.add({
          type: "error",
          title: "Worktree is in use",
          description: `Stop the active agent before deleting ${displayWorktreePath ?? orphanedWorktreePath}.`,
        });
      }

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch((error) => {
            reportBackgroundError(
              "Failed to stop the thread session before deleting the thread.",
              error,
            );
          });
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      const deletedThreadIds = opts.deletedThreadIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads: threadEntries,
        deletedThreadId: threadId,
        deletedThreadIds,
        sortOrder: sidebarThreadSortOrder,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          await navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          connectionUrl: resolveConnectionForProjectId(thread.projectId) ?? null,
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
        clearDraftsForDeletedWorktree(orphanedWorktreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      sidebarThreadSortOrder,
      navigate,
      removeWorktreeMutation,
      routeThreadId,
    ],
  );

  const deleteWorktreeAndRelatedData = async ({
    connectionUrl,
    projectId,
    projectCwd,
    skipConfirmation = false,
    suppressSuccessToast = false,
    worktreePath: rawWorktreePath,
  }: DeleteWorktreeAndRelatedDataInput) => {
    const api = readNativeApi();
    if (!api) return;
    const { sidebarThreadsById, threads } = useStore.getState();
    const threadEntries = getProjectThreadActionEntries({
      projectId,
      sidebarThreadsById,
      threads,
    });
    const worktreePath = normalizeWorktreePath(rawWorktreePath);
    if (!worktreePath) return;

    const relatedThreadIds = getWorktreeLinkedThreadIds(threadEntries, worktreePath);
    const relatedThreads = threadEntries.filter((thread) => relatedThreadIds.includes(thread.id));
    const activeThread = relatedThreads.find(isWorktreeThreadSessionActive);

    const displayWorktreePath = formatWorktreePathForDisplay(worktreePath);
    if (activeThread) {
      toastManager.add({
        type: "error",
        title: "Worktree is in use",
        description: `Stop the active agent in "${activeThread.title}" before deleting ${displayWorktreePath}.`,
      });
      return;
    }

    if (!skipConfirmation) {
      const confirmed = await api.dialogs.confirm(
        relatedThreadIds.length > 0
          ? [
              `Delete worktree "${displayWorktreePath}" and ${relatedThreadIds.length} related chat${
                relatedThreadIds.length === 1 ? "" : "s"
              }?`,
              "This permanently clears the related conversation history and removes the worktree directory.",
            ].join("\n")
          : [
              `Delete worktree "${displayWorktreePath}"?`,
              "This permanently removes the worktree directory.",
            ].join("\n"),
      );
      if (!confirmed) {
        return;
      }
    }

    const deletedThreadIds = new Set<ThreadId>(relatedThreadIds);
    for (const relatedThreadId of relatedThreadIds) {
      await deleteThread(relatedThreadId, {
        deletedThreadIds,
        worktreeRemovalPrompt: "skip",
      });
    }

    try {
      await removeWorktreeMutation.mutateAsync({
        connectionUrl: connectionUrl ?? resolveConnectionForProjectId(projectId) ?? null,
        cwd: projectCwd,
        path: worktreePath,
        force: true,
      });
      clearDraftsForDeletedWorktree(worktreePath);
      if (!suppressSuccessToast) {
        toastManager.add({
          type: "success",
          title: "Worktree cleaned up",
          description:
            relatedThreadIds.length > 0
              ? `Removed ${displayWorktreePath} and ${relatedThreadIds.length} related chat${
                  relatedThreadIds.length === 1 ? "" : "s"
                }.`
              : `Removed ${displayWorktreePath}.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
      console.error("Failed to remove worktree after deleting related threads", {
        projectCwd,
        worktreePath,
        error,
      });
      toastManager.add({
        type: "error",
        title: "Chats deleted, but worktree removal failed",
        description: `Could not remove ${displayWorktreePath}. ${message}`,
      });
    }
  };

  const deleteWorktreeAndRelatedThreads = async (threadId: ThreadId) => {
    const { projects, threads } = useStore.getState();
    const thread = threads.find((entry) => entry.id === threadId);
    if (!thread) return;
    const threadProject = projects.find((project) => project.id === thread.projectId);
    if (!threadProject) return;
    await deleteWorktreeAndRelatedData({
      connectionUrl: resolveConnectionForProjectId(thread.projectId) ?? null,
      projectId: thread.projectId,
      projectCwd: threadProject.cwd,
      worktreePath: thread.worktreePath ?? "",
    });
  };

  const confirmAndDeleteThread = async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
    if (!thread) return;

    if (confirmThreadDelete) {
      const confirmed = await api.dialogs.confirm(
        [
          `Delete thread "${thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }
    }

    await deleteThread(threadId);
  };

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    deleteWorktreeAndRelatedData,
    deleteWorktreeAndRelatedThreads,
    confirmAndDeleteThread,
  };
}

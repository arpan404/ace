import type { Thread, SidebarThreadSummary } from "./types";

type WorktreeThread = Pick<Thread | SidebarThreadSummary, "id" | "worktreePath">;
type WorktreeSessionThread = Pick<Thread, "session">;

export function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  if (normalizedSeparators === "/" || /^[A-Za-z]:\/$/.test(normalizedSeparators)) {
    return normalizedSeparators;
  }
  return normalizedSeparators.replace(/\/+$/, "");
}

export function getOrphanedWorktreePathForThread(
  threads: readonly WorktreeThread[],
  threadId: WorktreeThread["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function getWorktreeLinkedThreadIds(
  threads: readonly WorktreeThread[],
  worktreePath: string | null,
): WorktreeThread["id"][] {
  const normalizedWorktreePath = normalizeWorktreePath(worktreePath);
  if (!normalizedWorktreePath) {
    return [];
  }

  const linkedThreadIds: WorktreeThread["id"][] = [];
  for (const thread of threads) {
    if (normalizeWorktreePath(thread.worktreePath) === normalizedWorktreePath) {
      linkedThreadIds.push(thread.id);
    }
  }
  return linkedThreadIds;
}

export function isWorktreeThreadSessionActive(thread: WorktreeSessionThread): boolean {
  return (
    thread.session !== null &&
    thread.session !== undefined &&
    thread.session.status !== "closed" &&
    (thread.session.status === "running" || thread.session.activeTurnId != null)
  );
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

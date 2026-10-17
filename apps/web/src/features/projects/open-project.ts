import type { SidebarReader } from "@ace/client";
import { useSidebarStore } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { focusComposerSoon } from "@/lib/focus-composer.ts";

/** The project's most recently updated thread in the list, if it has one. */
export function latestThread(reader: SidebarReader, projectId: string): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const id of reader.ids) {
    const thread = reader.thread(id);
    if (thread?.workspaceId !== projectId) continue;
    if (!best || thread.updatedAt > best.at) best = { id, at: thread.updatedAt };
  }
  return best?.id;
}

/**
 * Open a project: its latest thread when it has one, else a new thread draft in it. The caret
 * lands in the message box either way.
 */
export function useOpenProject(): (projectId: string) => void {
  const navigate = useNavigate();
  const sidebar = useSidebarStore();
  return useCallback(
    (projectId: string) => {
      const threadId = sidebar
        ?.select(["ids", "threads"], (reader) => latestThread(reader, projectId))
        .getSnapshot();
      if (threadId) void navigate({ to: "/t/$threadId", params: { threadId } });
      else void navigate({ to: "/new", search: { project: projectId } });
      focusComposerSoon();
    },
    [navigate, sidebar],
  );
}

import type { SidebarReader } from "@ace/client";
import { useSidebarStore } from "@ace/client-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useOrganizer } from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { chatChoice } from "@/lib/chat-choice.ts";

/** The project of the list's most recently updated thread. */
function latestProject(reader: SidebarReader): string | undefined {
  let best: { project: string; at: number } | undefined;
  for (const id of reader.ids) {
    const thread = reader.thread(id);
    if (thread && (!best || thread.updatedAt > best.at))
      best = { project: thread.workspaceId, at: thread.updatedAt };
  }
  return best?.project;
}

/**
 * Ways into a new thread. `start` asks where when it has to: with no project it opens a chat
 * with no project, with one it opens the draft there, with several the palette's "New thread
 * in…". `here` skips the question: the open thread's project (another chat from a chat), else
 * the project Home is filtered to, else the one worked in last.
 */
export function useNewThreadEntry(): { start(): void; here(): void } {
  const navigate = useNavigate();
  const { openPalette } = useLayout();
  const directory = useProjectDirectory();
  const organizer = useOrganizer();
  const sidebar = useSidebarStore();
  const open = useParams({ strict: false }).threadId;
  const { projects } = directory;
  const draft = useCallback(
    (project: string) => void navigate({ to: "/new", search: { project } }),
    [navigate],
  );
  const start = useCallback(() => {
    const only = projects.length === 1 ? projects[0] : undefined;
    if (only) draft(only.id);
    else if (projects.length > 1) openPalette({ page: "new-thread-in" });
    else if (directory.loaded) draft(chatChoice);
    else void navigate({ to: "/new" });
  }, [projects, directory.loaded, draft, openPalette, navigate]);
  const here = useCallback(() => {
    const known = (id: string | null | undefined) =>
      id && projects.some((project) => project.id === id) ? id : undefined;
    const fromThread = open
      ? sidebar?.select(["ids", "threads"], (reader) => reader.thread(open)?.workspaceId)
      : undefined;
    const threadProject = fromThread?.getSnapshot();
    if (threadProject && directory.isChat(threadProject)) return draft(chatChoice);
    const project =
      known(threadProject) ??
      known(organizer.getState().project) ??
      known(sidebar?.select(["ids", "threads"], latestProject).getSnapshot()) ??
      projects[0]?.id;
    if (project) draft(project);
    else start();
  }, [open, sidebar, organizer, projects, directory, draft, start]);
  return useMemo(() => ({ start, here }), [start, here]);
}

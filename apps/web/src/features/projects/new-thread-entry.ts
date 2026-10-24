import type { SidebarReader } from "@ace/client";
import { useSidebarStore } from "@ace/client-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useOrganizer } from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useMachines } from "@/lib/machines.ts";
import { useProjectDirectory } from "@/lib/projects.ts";

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
 * Ways into a new thread. `start` asks where when it has to: with no project it opens Add
 * project, with one it opens the draft there, with several, or while another machine is online,
 * the palette's "New thread in…" (which chooses the machine too).
 * `here` skips the question: the open thread's project, else the project Home is filtered to,
 * else the one worked in last. `only` is the project `start` opens without asking, if any.
 */
export function useNewThreadEntry(): { start(): void; here(): void; only: string | undefined } {
  const navigate = useNavigate();
  const { openPalette } = useLayout();
  const directory = useProjectDirectory();
  const organizer = useOrganizer();
  const sidebar = useSidebarStore();
  const open = useParams({ strict: false }).threadId;
  const { projects } = directory;
  const machines = useMachines();
  const elsewhere = machines.some((machine) => !machine.primary && machine.status === "online");
  const draft = useCallback(
    (project: string) => void navigate({ to: "/new", search: { project } }),
    [navigate],
  );
  const only = projects.length === 1 && !elsewhere ? projects[0]?.id : undefined;
  const start = useCallback(() => {
    if (only) draft(only);
    else if (projects.length > 1 || elsewhere) openPalette({ page: "new-thread-in" });
    else if (directory.loaded) openPalette({ page: "add-project" });
    else void navigate({ to: "/new" });
  }, [only, projects, elsewhere, directory.loaded, draft, openPalette, navigate]);
  const here = useCallback(() => {
    const known = (id: string | null | undefined) =>
      id && projects.some((project) => project.id === id) ? id : undefined;
    const fromThread = open
      ? sidebar?.select(["ids", "threads"], (reader) => reader.thread(open)?.workspaceId)
      : undefined;
    const project =
      known(fromThread?.getSnapshot()) ??
      known(organizer.getState().project) ??
      known(sidebar?.select(["ids", "threads"], latestProject).getSnapshot()) ??
      projects[0]?.id;
    if (project) draft(project);
    else start();
  }, [open, sidebar, organizer, projects, draft, start]);
  return useMemo(() => ({ start, here, only }), [start, here, only]);
}

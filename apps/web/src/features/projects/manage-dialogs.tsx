import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import { displayPath } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Footer, Problem } from "./form-parts.tsx";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import { useHostHome } from "./use-folders.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";

function useProject(projectId: string) {
  return useProjectDirectory().projects.find((project) => project.id === projectId);
}

const settledStates = new Set(["new", "done", "failed"]);

/** Threads in a project that are still going: removal waits for them or archives them. */
function useRunningThreads(projectId: string): number {
  return (
    useSidebarAll(
      (reader: SidebarReader) =>
        reader.ids.filter((id) => {
          const thread = reader.thread(id);
          return (
            thread?.workspaceId === projectId &&
            thread.archivedAt === undefined &&
            !settledStates.has(thread.status.state)
          );
        }).length,
      Object.is,
    ) ?? 0
  );
}

/**
 * Remove: ace stops listing the project; nothing on disk is deleted. While its threads still
 * run, the daemon refuses, and the person can archive them and remove it anyway (archived
 * threads finish their work).
 */
export function RemoveProjectDialog(props: {
  projectId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const project = useProject(props.projectId);
  const home = useHostHome(usePrimaryMachine()).data;
  const commands = useProjectCommands();
  const toast = useToast();
  const running = useRunningThreads(props.projectId);
  const [busy, setBusy] = useState(false);
  const [refusedRunning, setRefusedRunning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const name = project?.name ?? "this project";

  const remove = async (archiveThreads: boolean) => {
    if (!project) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await commands.remove(project.id, archiveThreads);
      if (!current.current) return;
      toast.add({
        title: `Removed ${project.name}`,
        description: "Its folder is still on disk. Add it again any time.",
      });
      props.onOpenChange(false);
    } catch (error) {
      if (!current.current) return;
      const failure = projectFailure(error);
      if (failure.code === "workspace_threads_running") setRefusedRunning(true);
      else setProblem(failure.message);
    } finally {
      if (current.current) setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {name}?</DialogTitle>
          <DialogDescription>
            This won't delete any files.{" "}
            {project ? (
              <>
                ace stops listing the project;{" "}
                <span className="font-mono text-[12.5px]">
                  {displayPath(project.path, home?.path)}
                </span>{" "}
                stays on disk and you can add it again later.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {!project && <Problem>That project is gone.</Problem>}
        {refusedRunning ? (
          <Problem>
            {running === 1
              ? `A thread in ${name} is still running.`
              : running > 1
                ? `${running} threads in ${name} are still running.`
                : `Threads in ${name} are still running.`}{" "}
            Archive its threads to remove it now: they keep running until they finish, and stay in
            Archived.
          </Problem>
        ) : (
          problem && <Problem>{problem}</Problem>
        )}
        <Footer>
          {refusedRunning ? (
            <Button variant="danger" disabled={busy} onClick={() => void remove(true)}>
              {busy ? "Removing…" : "Archive threads and remove"}
            </Button>
          ) : (
            <Button variant="danger" disabled={busy || !project} onClick={() => void remove(false)}>
              {busy ? "Removing…" : "Remove project"}
            </Button>
          )}
        </Footer>
      </DialogContent>
    </Dialog>
  );
}

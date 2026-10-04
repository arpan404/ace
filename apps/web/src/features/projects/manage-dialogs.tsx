import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import { displayPath, projectNameProblem } from "@ace/ui-core";
import { useState } from "react";
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
import { Footer, Problem, TextField } from "./form-parts.tsx";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import { useHostHome } from "./use-folders.ts";

function useProject(projectId: string) {
  return useProjectDirectory().projects.find((project) => project.id === projectId);
}

/** Rename: the name ace shows. The folder on disk keeps its own. */
export function RenameProjectDialog(props: {
  projectId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const project = useProject(props.projectId);
  const commands = useProjectCommands();
  const toast = useToast();
  const [name, setName] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const value = name ?? project?.name ?? "";
  const nameProblem = projectNameProblem(value.trim());

  const save = async () => {
    if (!project || nameProblem) return;
    if (value.trim() === project.name) return props.onOpenChange(false);
    setSaving(true);
    setProblem(undefined);
    try {
      await commands.rename(project.id, value.trim());
      toast.add({ title: `Renamed to ${value.trim()}` });
      props.onOpenChange(false);
    } catch (error) {
      setProblem(projectFailure(error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {project?.name ?? "project"}</DialogTitle>
            <DialogDescription>
              Changes the name ace shows on every device. The folder on disk keeps its name.
            </DialogDescription>
          </DialogHeader>
          {project ? (
            <TextField
              label="Name"
              value={value}
              onChange={setName}
              problem={nameProblem}
              showProblem={name !== undefined}
              autoFocus
            />
          ) : (
            <Problem>That project is gone.</Problem>
          )}
          {problem && <Problem>{problem}</Problem>}
          <Footer>
            <Button type="submit" variant="primary" disabled={!project || saving}>
              {saving ? "Saving…" : "Rename"}
            </Button>
          </Footer>
        </form>
      </DialogContent>
    </Dialog>
  );
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
  const home = useHostHome().data;
  const commands = useProjectCommands();
  const toast = useToast();
  const running = useRunningThreads(props.projectId);
  const [busy, setBusy] = useState(false);
  const [refusedRunning, setRefusedRunning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const name = project?.name ?? "this project";

  const remove = async (archiveThreads: boolean) => {
    if (!project) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await commands.remove(project.id, archiveThreads);
      toast.add({
        title: `Removed ${project.name}`,
        description: "Its folder is still on disk. Add it again any time.",
      });
      props.onOpenChange(false);
    } catch (error) {
      const failure = projectFailure(error);
      if (failure.code === "workspace_threads_running") setRefusedRunning(true);
      else setProblem(failure.message);
    } finally {
      setBusy(false);
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

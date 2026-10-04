import { useEffect, useState } from "react";
import { desktopFolders } from "@/boot/desktop-folders.ts";
import { AddProjectDialog } from "./add-project-dialog.tsx";
import { useLandInProject } from "./land.ts";
import { RemoveProjectDialog, RenameProjectDialog } from "./manage-dialogs.tsx";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import type { AddTab, FolderAttempt, ProjectRequest } from "./requests.ts";
import { useCloneRun } from "./use-clone-run.ts";

/**
 * The project dialogs, loaded on first use (ADR 0056) and kept mounted after, so a clone in
 * progress survives its dialog closing. A folder request (dropped, picked natively) adds the
 * folder straight away and opens New thread in it; when the daemon refuses, Add project opens
 * with the reason beside that folder.
 */
export default function ProjectDialogs(props: {
  request: ProjectRequest;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRequest(request: ProjectRequest): void;
}) {
  const { request, open, onOpenChange, onRequest } = props;
  const land = useLandInProject();
  const commands = useProjectCommands();
  const [tab, setTab] = useState<AddTab>("open");
  const [attempt, setAttempt] = useState<FolderAttempt>();
  // Each Add project request picks its tab and the folder it is about.
  const [shown, setShown] = useState<ProjectRequest>();
  if (shown !== request) {
    setShown(request);
    if (request.kind === "add") {
      setTab(request.tab);
      setAttempt(request.attempt);
    }
  }
  const clone = useCloneRun({
    visible: open && request.kind === "add",
    onCloned: (result) => {
      onOpenChange(false);
      land(result, "Cloned");
    },
  });

  // A dropped folder is a folder request in the desktop app, which knows its path; a browser
  // doesn't share it, so there Add project opens to pick it from the daemon's side.
  useEffect(() => {
    if (request.kind !== "dropped") return;
    const path = desktopFolders()?.pathOf(request.file);
    onRequest(path ? { kind: "folder", path } : { kind: "add", tab: "open" });
  }, [request, onRequest]);

  // A folder request is added here and never shows a dialog unless it fails.
  useEffect(() => {
    if (request.kind !== "folder") return;
    let current = true;
    onOpenChange(false);
    commands.add(request.path).then(
      (result) => {
        if (current) land(result);
      },
      (error: unknown) => {
        if (current)
          onRequest({
            kind: "add",
            tab: "open",
            attempt: { path: request.path, problem: projectFailure(error).message },
          });
      },
    );
    return () => {
      current = false;
    };
  }, [request, commands, land, onOpenChange, onRequest]);

  if (request.kind === "rename")
    return (
      <RenameProjectDialog projectId={request.projectId} open={open} onOpenChange={onOpenChange} />
    );
  if (request.kind === "remove")
    return (
      <RemoveProjectDialog projectId={request.projectId} open={open} onOpenChange={onOpenChange} />
    );
  return (
    <AddProjectDialog
      open={open && request.kind === "add"}
      onOpenChange={onOpenChange}
      tab={tab}
      onTab={setTab}
      attempt={attempt}
      clone={clone}
      onAdded={(result, verb) => {
        onOpenChange(false);
        land(result, verb);
      }}
    />
  );
}

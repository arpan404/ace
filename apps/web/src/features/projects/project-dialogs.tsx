import { PublishRepositoryDialog } from "./publish-repository-dialog.tsx";
import { useEffect, useRef, useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { desktopFolders } from "@/boot/desktop-folders.ts";
import { AddProjectDialog } from "./add-project-dialog.tsx";
import { useLandInProject } from "./land.ts";
import { RemoveProjectDialog } from "./manage-dialogs.tsx";
import { EditProjectDialog } from "./edit-project-dialog.tsx";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import type { AddTab, FolderAttempt, ProjectRequest } from "./requests.ts";
import { useCloneRun } from "./use-clone-run.ts";
import { useMachines } from "@/lib/machines.ts";

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
  const endpoint = useDaemonConnection().endpoint;
  const target = endpoint?.kind === "daemon" ? endpoint.target : undefined;
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
  const machines = useMachines();
  const clone = useCloneRun({
    machines,
    visible: open && request.kind === "add",
    onCloned: (result, machine) => {
      onOpenChange(false);
      land(result, "Cloned", { machine });
    },
  });

  // A dropped folder is a folder request in the desktop app, which knows its path; a browser
  // doesn't share it, so there Add project opens to pick it from the daemon's side.
  useEffect(() => {
    if (request.kind !== "dropped") return;
    const picker = desktopFolders();
    let current = true;
    void (async () => {
      const local = await picker?.local(target);
      if (!current) return;
      const path = local && target ? picker?.pathOf(request.file) : undefined;
      onRequest(path && target ? { kind: "folder", path, target } : { kind: "add", tab: "open" });
    })();
    return () => {
      current = false;
    };
  }, [request, onRequest, target]);

  // A folder request is added here and never shows a dialog unless it fails. Once per request:
  // the latest callbacks, without adding again when they change.
  const latest = useRef({ commands, land, onOpenChange, onRequest });
  useEffect(() => {
    latest.current = { commands, land, onOpenChange, onRequest };
  });
  useEffect(() => {
    if (request.kind !== "folder") return;
    let current = true;
    const run = latest.current;
    if (request.target !== target) {
      run.onRequest({ kind: "add", tab: "open" });
      return;
    }
    run.onOpenChange(false);
    run.commands.add(request.path).then(
      (result) => {
        if (current) latest.current.land(result);
      },
      (error: unknown) => {
        if (current)
          latest.current.onRequest({
            kind: "add",
            tab: "open",
            attempt: {
              path: request.path,
              problem: projectFailure(error).message,
              canAllow: projectFailure(error).canAllow,
            },
          });
      },
    );
    return () => {
      current = false;
    };
  }, [request, target]);

  if (request.kind === "publish")
    return open ? (
      <PublishRepositoryDialog
        key={request.projectId}
        projectId={request.projectId}
        open={open}
        onOpenChange={onOpenChange}
      />
    ) : null;
  if (request.kind === "edit")
    return open ? (
      <EditProjectDialog
        key={request.projectId}
        projectId={request.projectId}
        open={open}
        onOpenChange={onOpenChange}
        onRequest={onRequest}
      />
    ) : null;
  if (request.kind === "remove")
    return open ? (
      <RemoveProjectDialog
        key={request.projectId}
        projectId={request.projectId}
        open={open}
        onOpenChange={onOpenChange}
      />
    ) : null;
  return (
    <AddProjectDialog
      open={open && request.kind === "add"}
      onOpenChange={onOpenChange}
      tab={tab}
      onTab={setTab}
      attempt={attempt}
      clone={clone}
      onAdded={(result, verb, options) => {
        onOpenChange(false);
        land(result, verb, options);
      }}
    />
  );
}

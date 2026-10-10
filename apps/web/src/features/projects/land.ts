import { useSidebarStore } from "@ace/client-react";
import { folderName, projectProblem } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { useOrganizer } from "@/features/organize/index.ts";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";

/**
 * Where a project opens: `thread` starts a new thread in it; `open` shows it, which is its
 * threads on Home when it has any and a new thread when it has none.
 */
export type LandMode = "thread" | "open";

export interface LandOptions {
  replace?: boolean;
  mode?: LandMode;
  /** The machine it was added on; another machine's project isn't shown in this window. */
  machine?: Machine;
}

/**
 * After a project is added, created or cloned: open it and say so. A folder inside a
 * repository offers the repository's root instead, which is added only if chosen. A project on
 * another machine is ready there; this window's screens show its own daemon, so it says that
 * instead of opening.
 */
export function useLandInProject(): (result: Added, verb?: string, options?: LandOptions) => void {
  const navigate = useNavigate();
  const toast = useToast();
  const commands = useProjectCommands();
  const organizer = useOrganizer();
  const sidebar = useSidebarStore();
  return useCallback(
    (result: Added, verb = "Added", options: LandOptions = {}) => {
      const { machine } = options;
      if (machine && !machine.primary) {
        toast.add({
          title: `${verb} ${result.project.name} on ${machine.name}`,
          description: `It's a project on ${machine.name} now. This window's threads run on its own machine.`,
        });
        return;
      }
      const hasThreads = (projectId: string) =>
        sidebar
          ?.select(["ids", "threads"], (reader) =>
            reader.ids.some((id) => reader.thread(id)?.workspaceId === projectId),
          )
          .getSnapshot() ?? false;
      const land = (added: Added, said: string, replace = false) => {
        const id = added.project.id;
        if (options.mode === "open" && hasThreads(id)) {
          organizer.setProject(id);
          void navigate({ to: "/", replace });
        } else void navigate({ to: "/new", search: { project: id }, replace });
        const root = added.suggestedRoot;
        const toastId = toast.add({
          title: `${said} ${added.project.name}`,
          ...(added.gitUnavailable
            ? { description: projectProblem(added.gitUnavailable).message, timeout: 10_000 }
            : {}),
          ...(root
            ? {
                description: `It's inside the ${folderName(root)} repository.`,
                timeout: 10_000,
                actionProps: {
                  children: `Use ${folderName(root)}`,
                  onClick: () => {
                    toast.close(toastId);
                    commands.add(root).then(
                      (repository) => land(repository, "Added"),
                      (error: unknown) =>
                        toast.add({
                          title: `Couldn't add ${folderName(root)}`,
                          description: projectFailure(error).message,
                        }),
                    );
                  },
                },
              }
            : {}),
        });
      };
      land(result, verb, options.replace);
    },
    [navigate, toast, commands, organizer, sidebar],
  );
}

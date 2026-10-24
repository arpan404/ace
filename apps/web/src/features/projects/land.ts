import { useSidebarStore } from "@ace/client-react";
import { folderName, projectProblem } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { newThreadOn } from "@/lib/machine-routes.ts";
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
  /** The machine it was added on; another machine's project opens New thread there. */
  machine?: Machine;
}

/**
 * After a project is added, created or cloned: open it. A folder inside a repository offers the
 * repository's root instead, in a toast, which is added only if chosen. A project on
 * another machine opens New thread on that machine (ADR 0100).
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
        // Opening it there is the confirmation: the composer's strip names the machine.
        void navigate({
          ...newThreadOn(machine.id, result.project.id),
          replace: !!options.replace,
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
        // Opening it is the confirmation; a toast only carries something to act on or know.
        if (!root && !added.gitUnavailable) return;
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
                        toast.error({
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

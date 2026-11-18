import { useSidebarStore } from "@ace/client-react";
import { folderName, projectProblem } from "@ace/ui-core";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { newThreadOn } from "@/lib/machine-routes.ts";
import type { Machine } from "@/lib/machines.ts";
import { useOrganizer } from "@/features/organize/index.ts";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";
import { useProjectDialogsIfHosted } from "./projects-context.ts";

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
 * New thread `navigate` options for a project on `machine`: this window's own New thread for
 * the primary machine (or none), New thread on that machine for another one (ADR 0102).
 */
export function newThreadIn(projectId: string, machine?: Machine) {
  return newThreadOn(machine && !machine.primary ? machine.id : undefined, projectId);
}

/**
 * Where a project just added opens: New thread in it (`newThreadIn`), unless it was added from
 * first-run setup on this window's own machine, which goes on to setup's Done step.
 */
export function landingIn(pathname: string, projectId: string, machine?: Machine) {
  if (pathname === "/setup" && (!machine || machine.primary))
    return { to: "/setup" as const, search: { step: "done" as const, project: projectId } };
  return newThreadIn(projectId, machine);
}

/**
 * After a project is added, created or cloned: open it. A folder inside a repository offers the
 * repository's root instead, in a toast, which is added only if chosen. A project on
 * another machine opens New thread on that machine (ADR 0102).
 */
export function useLandInProject(): (result: Added, verb?: string, options?: LandOptions) => void {
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const commands = useProjectCommands();
  const organizer = useOrganizer();
  const sidebar = useSidebarStore();
  const dialogs = useProjectDialogsIfHosted();
  return useCallback(
    (result: Added, verb = "Added", options: LandOptions = {}) => {
      const { machine } = options;
      // A folder that carries a project marker asks before it joins that project (ADR 0181).
      const marker = result.marker;
      if (marker)
        dialogs?.open({
          kind: "marker",
          projectId: result.project.id,
          machineId: machine && !machine.primary ? machine.id : undefined,
          marker,
        });
      if (machine && !machine.primary) {
        // Opening it there is the confirmation: the composer's strip names the machine.
        void navigate({ ...newThreadIn(result.project.id, machine), replace: !!options.replace });
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
        } else void navigate({ ...landingIn(router.state.location.pathname, id), replace });
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
    [navigate, router, toast, commands, organizer, sidebar, dialogs],
  );
}

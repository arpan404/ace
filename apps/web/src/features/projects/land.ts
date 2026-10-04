import { folderName } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";

/**
 * After a project is added, created or cloned: open New thread in it and say so. A folder
 * inside a repository offers the repository's root instead, which is added only if chosen.
 */
export function useLandInProject(): (
  result: Added,
  verb?: string,
  options?: { replace?: boolean },
) => void {
  const navigate = useNavigate();
  const toast = useToast();
  const commands = useProjectCommands();
  return useCallback(
    (result: Added, verb = "Added", options: { replace?: boolean } = {}) => {
      const land = (added: Added, said: string, replace = false) => {
        void navigate({ to: "/new", search: { project: added.project.id }, replace });
        const root = added.suggestedRoot;
        const id = toast.add({
          title: `${said} ${added.project.name}`,
          ...(root
            ? {
                description: `It's inside the ${folderName(root)} repository.`,
                timeout: 10_000,
                actionProps: {
                  children: `Use ${folderName(root)}`,
                  onClick: () => {
                    toast.close(id);
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
    [navigate, toast, commands],
  );
}

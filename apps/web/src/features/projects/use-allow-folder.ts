import type { ClientApi } from "@ace/client";
import { displayPath, folderName } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { addProjectRoot, removeProjectRoot } from "@/lib/project-roots.ts";

/**
 * Allowing a folder outside a machine's allowed places, in one action with no confirmation:
 * the toast's Undo stops allowing just that folder. Places allowed meanwhile stay allowed, and
 * nothing added in it is removed (a project there is hidden until it's allowed again, its
 * threads kept), so Undo never loses work. Rejects when the machine refuses the folder.
 */
export function useAllowFolder(): (client: ClientApi, path: string) => Promise<void> {
  const queries = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (client: ClientApi, path: string) => {
      await addProjectRoot(client, path);
      await queries.invalidateQueries({ queryKey: ["projects", "folders"] });
      const toastId = toast.add({
        title: `Allowed ${displayPath(path, undefined)}`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            removeProjectRoot(client, path)
              // The project list and the folders both change with the allowed places.
              .then(() => queries.invalidateQueries({ queryKey: ["projects"] }))
              .catch(() =>
                toast.error({
                  title: `Couldn't undo allowing ${folderName(path)}. Remove it in Settings.`,
                }),
              );
          },
        },
      });
    },
    [queries, toast],
  );
}

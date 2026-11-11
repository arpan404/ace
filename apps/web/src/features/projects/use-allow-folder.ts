import type { ClientApi } from "@ace/client";
import { actionErrorText, displayPath, folderName } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { ProjectRootRefused, addProjectRoot, removeProjectRoot } from "@/lib/project-roots.ts";
import { readProjects } from "@/lib/projects.ts";

const trim = (path: string) => path.replace(/\/+$/, "") || "/";
const inside = (folder: string, path: string) => {
  const [outer, inner] = [trim(folder), trim(path)];
  return inner === outer || inner.startsWith(outer === "/" ? "/" : `${outer}/`);
};

/** The project a new thread draft at `location` is for, if it is one. */
function draftProject(location: { pathname: string; search: unknown }): string | undefined {
  if (location.pathname !== "/new") return undefined;
  const search = location.search;
  if (typeof search !== "object" || search === null || !("project" in search)) return undefined;
  return typeof search.project === "string" ? search.project : undefined;
}

/**
 * Allowing a folder outside a machine's allowed places, in one action with no confirmation:
 * the toast's Undo stops allowing just that folder. Places allowed meanwhile stay allowed, and
 * nothing added in it is removed (a project there is hidden until it's allowed again, its
 * threads kept), so Undo never loses work. A new thread draft open for a project in it closes
 * to Home, since the project is hidden. Rejects when the machine refuses the folder.
 */
export function useAllowFolder(): (client: ClientApi, path: string) => Promise<void> {
  const queries = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  return useCallback(
    async (client: ClientApi, path: string) => {
      await addProjectRoot(client, path);
      await queries.invalidateQueries({ queryKey: ["projects", "folders"] });
      const undo = async () => {
        // Read while the project is still listed: once the folder isn't allowed it's hidden.
        const drafting = draftProject(router.state.location);
        const hidden = drafting
          ? (await readProjects(client).catch(() => [])).some(
              (project) => project.id === drafting && inside(path, project.path),
            )
          : false;
        await removeProjectRoot(client, path);
        // The project list and the folders both change with the allowed places.
        await queries.invalidateQueries({ queryKey: ["projects"] });
        if (hidden && draftProject(router.state.location) === drafting)
          await router.navigate({ to: "/" });
      };
      const toastId = toast.add({
        title: `Allowed ${displayPath(path, undefined)}`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            undo().catch((error: unknown) =>
              toast.error({
                title:
                  error instanceof ProjectRootRefused && error.code === "last_root"
                    ? actionErrorText(error.code)
                    : `Couldn't undo allowing ${folderName(path)}. Remove it in Settings.`,
              }),
            );
          },
        },
      });
    },
    [queries, toast, router],
  );
}

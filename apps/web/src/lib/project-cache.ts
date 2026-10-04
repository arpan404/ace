import { useClient } from "@ace/client-react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/*
 * The shared project list's cache entry (read in `projects.ts`), kept apart so the app shell
 * can keep it live without loading the reads.
 */

/** A project (daemon workspace): its id on the wire, the name people know it by, its path. */
export interface Project {
  id: string;
  name: string;
  path: string;
}

export const projectsKey = ["projects"];

/**
 * Put a project the daemon just registered or renamed into the shared list, so a screen that
 * selects it (New thread in the project just added) finds it before the next read.
 */
export function rememberProject(queryClient: QueryClient, project: Project): void {
  queryClient.setQueryData<Project[]>(projectsKey, (list) =>
    list ? [...list.filter((p) => p.id !== project.id), project] : list,
  );
  settle(queryClient);
}

/** Drop a removed project from the shared list. */
export function forgetProject(queryClient: QueryClient, id: string): void {
  queryClient.setQueryData<Project[]>(projectsKey, (list) => list?.filter((p) => p.id !== id));
  settle(queryClient);
}

/**
 * Read the list again behind the edit. A first read still in flight (sent before the change,
 * so without it) is dropped rather than joined: Query would otherwise hand its old answer to
 * the refetch and put the old list back.
 */
function settle(queryClient: QueryClient): void {
  const exact = { queryKey: projectsKey, exact: true };
  void queryClient
    .cancelQueries(exact)
    .then(() => queryClient.invalidateQueries(exact))
    .catch(() => {});
}

/**
 * Keep every screen's project list live: the daemon pushes each project added, renamed or
 * removed, from this device or another. A reconnect reads the list again (`useDaemonQuery`),
 * which covers pushes missed while offline. Mount once, in the app shell.
 */
export function useProjectListSync(): void {
  const client = useClient();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      client.projects.onChanged((change) => {
        if (change.change === "removed") forgetProject(queryClient, change.workspaceId);
        else if (change.workspace) rememberProject(queryClient, change.workspace);
        else settle(queryClient);
      }),
    [client, queryClient],
  );
}

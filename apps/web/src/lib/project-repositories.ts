import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  SourceControlPreferences,
  WorkspaceId,
  type ProjectRepositories,
  type ProjectRepositoryConfig,
} from "@ace/protocol";
import { pushRemote } from "@ace/ui-core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { runCommand } from "./daemon-command.ts";
import { useDaemonQuery } from "./daemon-query.ts";
import { readForge } from "./forge-read.ts";
import { forgetProjectRepositories, projectRepositoriesKey } from "./project-cache.ts";

/*
 * A project's repositories (ADR 0116) as the web reads and saves them. The read is local to the
 * daemon (no request to a Git host). It is read again when the project changes
 * (`workspace.changed`, `forgetProjectRepositories`) and when source control settings change,
 * which resets every `forge` read.
 */

export async function readProjectRepositories(
  client: ClientApi,
  project: string,
  signal: AbortSignal,
): Promise<ProjectRepositories> {
  const value = await readForge(client, { op: "forge.repositories", workspaceId: project }, signal);
  if (value.resource !== "repositories") throw new Error("No repositories.");
  return value.value;
}

/** Each project's repositories by id, once read; a project whose read failed is absent. */
export interface RepositoryLists {
  lists: ReadonlyMap<string, ProjectRepositories>;
  /** Projects whose read hasn't answered yet. */
  pending: ReadonlySet<string>;
}

export function useProjectRepositoryLists(projects: readonly string[]): RepositoryLists {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: projectRepositoriesKey(project),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readProjectRepositories(client, project, signal),
      enabled: ready,
      staleTime: 5 * 60_000,
      gcTime: 60 * 60_000,
      retry: false,
      meta: { daemonClient: client },
    })),
  });
  const lists = new Map<string, ProjectRepositories>();
  const pending = new Set<string>();
  results.forEach((result, index) => {
    const project = projects[index];
    if (!project) return;
    if (result.data) lists.set(project, result.data);
    else if (!result.isError) pending.add(project);
  });
  return { lists, pending };
}

/**
 * Save a project's repository choices (`workspace.repositories.set`); null clears them. Rejects
 * with `CommandRefused` and the daemon's code (`primary_hidden`, `workspace_not_found`...).
 */
export function useSaveProjectRepositories() {
  const client = useClient();
  const cache = useQueryClient();
  return async (project: string, repositories: ProjectRepositoryConfig | null) => {
    try {
      await runCommand(client, {
        type: "workspace.repositories.set",
        workspaceId: WorkspaceId.parse(project),
        repositories,
      });
    } finally {
      forgetProjectRepositories(cache, project);
    }
  };
}

/**
 * The remote a targeted push in this project names (`pushRemote`): the primary's remote when
 * the project has saved choices, else the global remote name. Undefined when the source control
 * settings can't be read. A daemon that can't list repositories keeps the global rule.
 */
export async function readPushRemote(
  client: ClientApi,
  project: string,
): Promise<string | undefined> {
  const signal = new AbortController().signal;
  const [settings, repositories] = await Promise.all([
    client.request({ type: "settings.get", key: "sourceControl.preferences", scope: {} }),
    readProjectRepositories(client, project, signal).catch(() => undefined),
  ]);
  const entry = settings.entries.find((item) => item.key === "sourceControl.preferences");
  const preferences = entry ? SourceControlPreferences.safeParse(entry.value) : undefined;
  if (!settings.ok || !preferences?.success) return undefined;
  return pushRemote(repositories, preferences.data.remote);
}

/**
 * The Git hosts in source control settings, to read a typed repository address the way the
 * daemon would. Read fresh each time a view that needs them opens.
 */
export function useSourceControlHosts() {
  return useDaemonQuery({
    queryKey: ["source-control", "hosts"],
    staleTime: 0,
    retry: false,
    read: async (client) => {
      const response = await client.request({
        type: "settings.get",
        key: "sourceControl.preferences",
        scope: {},
      });
      const entry = response.entries.find((item) => item.key === "sourceControl.preferences");
      const parsed = entry ? SourceControlPreferences.safeParse(entry.value) : undefined;
      if (!response.ok || !parsed?.success)
        throw new Error("Couldn't read source control settings.");
      return parsed.data.hosts;
    },
  });
}

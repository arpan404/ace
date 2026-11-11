import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  SourceControlPreferences,
  WorkspaceId,
  type ProjectRepositories,
  type ProjectRepositoryConfig,
} from "@ace/protocol";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { saveRepositoryEdit, type RepositoryEdit } from "@ace/ui-core";
import { CommandRefused, runCommand } from "./daemon-command.ts";
import { useDaemonQuery } from "./daemon-query.ts";
import { readForge } from "./forge-read.ts";
import { forgetProjectRepositories, projectRepositoriesKey } from "./project-cache.ts";

/*
 * A project's repositories (ADR 0120) as the web reads and saves them. The read is local to the
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
  /** Projects whose read failed: lists read only their primary, and say so. */
  failed: ReadonlySet<string>;
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
  const failed = new Set<string>();
  results.forEach((result, index) => {
    const project = projects[index];
    if (!project) return;
    if (result.data) lists.set(project, result.data);
    else if (result.isError) failed.add(project);
    else pending.add(project);
  });
  return { lists, pending, failed };
}

/**
 * Save one edit of a project's repository choices (`workspace.repositories.set`), applied to the
 * choices `from` it was made against. When another device saved meanwhile, the choices are read
 * again and the edit re-applied once (`saveRepositoryEdit`). Rejects with `CommandRefused` and
 * the daemon's code (`primary_hidden`, `repositories_changed`, `workspace_not_found`...).
 */
export function useSaveProjectRepositories() {
  const client = useClient();
  const cache = useQueryClient();
  return async (project: string, edit: RepositoryEdit, from: ProjectRepositoryConfig | null) => {
    const workspaceId = WorkspaceId.parse(project);
    try {
      const refused = await saveRepositoryEdit(
        {
          read: async () =>
            (await readProjectRepositories(client, project, new AbortController().signal)).config,
          save: (repositories, expected) =>
            runCommand(client, {
              type: "workspace.repositories.set",
              workspaceId,
              repositories,
              expected,
            }).then(
              () => undefined,
              (error: unknown) => {
                if (error instanceof CommandRefused) return error;
                throw error;
              },
            ),
          changed: (outcome) => outcome?.code === "repositories_changed",
        },
        edit,
        from,
      );
      if (refused) throw refused;
    } finally {
      forgetProjectRepositories(cache, project);
    }
  };
}

/**
 * The remote every push names: the global remote name, as the person's Git would push. The
 * push before a new pull request names it too; the daemon pushes that one to the PR's head
 * (the primary, or the person's fork of it, ADR 0120). Undefined when the source control
 * settings can't be read.
 */
export async function readPushRemote(client: ClientApi): Promise<string | undefined> {
  const settings = await client.request({
    type: "settings.get",
    key: "sourceControl.preferences",
    scope: {},
  });
  const entry = settings.entries.find((item) => item.key === "sourceControl.preferences");
  const preferences = entry ? SourceControlPreferences.safeParse(entry.value) : undefined;
  if (!settings.ok || !preferences?.success) return undefined;
  return preferences.data.remote;
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

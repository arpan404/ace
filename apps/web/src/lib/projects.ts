import type { ClientApi, SidebarReader } from "@ace/client";
import { useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import { useCallback, useEffect, useMemo } from "react";
import { useDaemonQuery } from "./daemon-query.ts";

/** A project (daemon workspace): its id on the wire, the name people know it by, its path. */
export interface Project {
  id: string;
  name: string;
  path: string;
}

/** The daemon pages `workspaces.list` at 100; a person with more projects sees the first 1,000. */
const pageSize = 100;
const maxPages = 10;

async function readProjects(client: ClientApi, signal: AbortSignal): Promise<Project[]> {
  const projects: Project[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const reply = await client.request(
      {
        type: "workspace.request",
        operation: { op: "workspaces.list", limit: pageSize, ...(after ? { after } : {}) },
      },
      { signal },
    );
    const result = reply.result;
    if (result.kind !== "workspaces") throw new Error("The daemon didn't list its projects.");
    projects.push(...result.workspaces);
    if (!result.next) break;
    after = result.next;
  }
  return projects;
}

const none: readonly string[] = [];
const readThreadProjects = (reader: SidebarReader) =>
  [...new Set(reader.ids.flatMap((id) => reader.thread(id)?.workspaceId ?? []))].toSorted();
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Ids of the projects that have threads on this daemon, sorted. Live from the thread list. */
export function useThreadProjects(): readonly string[] {
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  return useSidebar(keys, readThreadProjects, sameList) ?? none;
}

const projectsQuery = { queryKey: ["projects"], staleTime: 60_000, read: readProjects };

function useProjectList(): Project[] | undefined {
  return useDaemonQuery(projectsQuery).data;
}

function useNamer(data: readonly Project[] | undefined): (id: string) => string {
  const byId = useMemo(() => new Map((data ?? []).map((p) => [p.id, p.name])), [data]);
  return useCallback((id: string) => byId.get(id) ?? id, [byId]);
}

/**
 * A project's name by id, from the daemon's projects (`workspace.request` › `workspaces.list`),
 * read once and shared by every screen. The id stands in while loading or for an unknown project.
 * Cheap enough for every row: it subscribes to the one shared read, not the thread list.
 */
export function useProjectName(): (id: string) => string {
  return useNamer(useProjectList());
}

export interface ProjectDirectory {
  /** Every project the daemon knows, by name. Empty until read. */
  projects: readonly Project[];
  name(id: string): string;
}

/**
 * Every project the daemon knows. A thread in a project the directory hasn't seen reads it again,
 * so a project added on another device is named as soon as its first thread arrives. Pickers use
 * this; rows use `useProjectName`.
 */
export function useProjectDirectory(): ProjectDirectory {
  const fromThreads = useThreadProjects();
  const query = useDaemonQuery(projectsQuery);
  const data = query.data;
  const name = useNamer(data);
  // Read again once for each new set of unnamed projects (never in a loop for one the daemon
  // doesn't list, such as a deleted project's archived threads).
  const unknown =
    data === undefined
      ? ""
      : fromThreads.filter((id) => !data.some((project) => project.id === id)).join("\n");
  const { refetch } = query;
  useEffect(() => {
    if (unknown) void refetch({ cancelRefetch: false });
  }, [unknown, refetch]);
  const projects = useMemo(
    () => (data ?? []).toSorted((a, b) => a.name.localeCompare(b.name)),
    [data],
  );
  return useMemo(() => ({ projects, name }), [projects, name]);
}

/**
 * Project ids a picker offers: every project the daemon knows, those with threads, and `extra`
 * (ids a screen's own data mentions), sorted by name.
 */
export function useProjectChoices(extra: readonly string[] = none): {
  ids: readonly string[];
  name(id: string): string;
} {
  const directory = useProjectDirectory();
  const fromThreads = useThreadProjects();
  const { projects, name } = directory;
  const ids = useMemo(
    () =>
      [...new Set([...projects.map((p) => p.id), ...fromThreads, ...extra])]
        .filter(Boolean)
        .toSorted((a, b) => name(a).localeCompare(name(b))),
    [projects, fromThreads, extra, name],
  );
  return { ids, name };
}

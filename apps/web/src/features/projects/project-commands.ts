import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { CommandResult, Project, ProjectsResult } from "@ace/protocol";
import { projectProblem, type ProjectProblem } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";
import { forgetProject, rememberProject } from "@/lib/project-cache.ts";
import { useOrganizer } from "@/features/organize/index.ts";

/** The daemon refused a project command or folder read; `code` is its error code. */
export class ProjectRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(projectProblem(code).message);
    this.name = "ProjectRefused";
    this.code = code;
  }
}

/** What went wrong, for the dialog: the daemon's code and a sentence, or the connection. */
export function projectFailure(error: unknown): ProjectProblem & { code: string } {
  if (error instanceof ProjectRefused) return { code: error.code, ...projectProblem(error.code) };
  if (error instanceof Error && error.name === "ClientError") {
    const code = "code" in error ? String(error.code) : "unavailable";
    return code === "daemon"
      ? { code: error.message, ...projectProblem(error.message) }
      : { code, message: "Couldn't reach ace. Check the connection and try again." };
  }
  return { code: "project_failed", ...projectProblem("project_failed") };
}

/** A command's receipt, or `ProjectRefused` when the daemon said no. */
function accepted(result: CommandResult): CommandResult {
  if (!result.ok) throw new ProjectRefused(result.error ?? "project_failed");
  return result;
}

type Read = ProjectsResult["result"];
/** A folder read's answer of the expected kind, or `ProjectRefused` with the daemon's code. */
export function answer<K extends Read["kind"]>(
  reply: ProjectsResult,
  kind: K,
): Extract<Read, { kind: K }> {
  const result = reply.result;
  if (result.kind === "error") throw new ProjectRefused(result.code);
  if (result.kind !== kind) throw new ProjectRefused("project_failed");
  // The kind was just checked.
  return result as Extract<Read, { kind: K }>;
}

/** A registration receipt: the project, and the repository root the daemon suggests instead. */
export interface Added {
  project: Project;
  /** Set when the folder is inside a repository whose root is elsewhere. */
  suggestedRoot: string | undefined;
}

function added(result: CommandResult): Added {
  const receipt = accepted(result);
  if (!receipt.workspace) throw new ProjectRefused("project_failed");
  return {
    project: receipt.workspace,
    suggestedRoot: receipt.inspection?.suggestedRepoRoot,
  };
}

export interface CreateInput {
  parent: string;
  name: string;
  /** Run `git init` with this initial branch (the host's default when empty). */
  git?: { initialBranch?: string };
  /** Literal .gitignore text. */
  gitignore?: string;
}

/** A client that refuses everything: the chosen machine isn't connected. */
function unreachable(): never {
  throw new ProjectRefused("machine_offline");
}

/**
 * The project commands with their receipts checked, on `machine` (this window's daemon when
 * none is given). Commands for this window's daemon keep the shared project list in step as
 * soon as it answers (its push follows); another machine's projects aren't in that list. Each
 * rejects with `ProjectRefused` (`machine_offline` when the machine isn't connected; nothing
 * falls back to another machine) or the client's error.
 */
export function useProjectCommands(machine?: Machine) {
  const commandsOn = useProjectCommandsOn();
  return useMemo(() => commandsOn(machine), [commandsOn, machine]);
}

/** `useProjectCommands` for a machine chosen at call time (a row from any machine). */
export function useProjectCommandsOn() {
  const primary = useClient();
  const queryClient = useQueryClient();
  const organizer = useOrganizer();
  return useCallback(
    (machine?: Machine) => {
      const client = machine ? machine.client : primary;
      const shared = machine === undefined || machine.primary;
      const reach = () => client ?? unreachable();
      const keep = (result: Added) => {
        if (shared) rememberProject(queryClient, result.project);
        return result;
      };
      return {
        add: async (path: string) => keep(added(await reach().projects.add({ path }))),
        create: async (input: CreateInput) => keep(added(await reach().projects.create(input))),
        clone: async (input: { parent: string; name: string; url: string }, commandId: string) =>
          keep(added(await reach().projects.clone(input, {}, commandId))),
        cancelClone: async (commandId: string) =>
          answer(await reach().projects.cancelClone(commandId), "cancelled"),
        /** Clone progress pushed by this machine; returns the unsubscribe. */
        onCloneProgress: (listener: Parameters<ClientApi["projects"]["onCloneProgress"]>[0]) =>
          client ? client.projects.onCloneProgress(listener) : () => {},
        rename: async (workspaceId: string, name: string) => {
          const receipt = accepted(await reach().projects.rename({ workspaceId, name }));
          if (receipt.workspace && shared) rememberProject(queryClient, receipt.workspace);
        },
        remove: async (workspaceId: string, archiveThreads: boolean) => {
          accepted(await reach().projects.remove({ workspaceId, archiveThreads }));
          if (!shared) return;
          forgetProject(queryClient, workspaceId);
          // Home stops filtering on a project that is gone.
          if (organizer.getState().project === workspaceId) organizer.setProject(null);
        },
      };
    },
    [primary, queryClient, organizer],
  );
}

export type ProjectCommands = ReturnType<typeof useProjectCommands>;

/** The folder reads, for the browser and the dialog's hints. */
export function projectReads(client: ClientApi) {
  return {
    home: async (signal: AbortSignal) => answer(await client.projects.home({ signal }), "home"),
    recent: async (limit: number, signal: AbortSignal) =>
      answer(await client.projects.recentFolders(limit, { signal }), "recentFolders"),
    browse: async (
      input: { path: string; after?: string; showHidden: boolean },
      signal: AbortSignal,
    ) =>
      answer(
        await client.projects.browse(
          {
            path: input.path,
            limit: 100,
            showHidden: input.showHidden,
            ...(input.after ? { after: input.after } : {}),
          },
          { signal },
        ),
        "directories",
      ),
    /** The daemon's ranked folder search (`fs.search`); a newer one supersedes it. */
    search: async (query: string, signal: AbortSignal) =>
      answer(await client.projects.search({ query, limit: 50 }, { signal }), "search"),
    /** Path completion (`fs.complete`) for an absolute or `~/` path. */
    complete: async (path: string, showHidden: boolean, signal: AbortSignal) =>
      answer(
        await client.projects.complete({ path, limit: 50, showHidden }, { signal }),
        "completion",
      ),
    /** A clone address checked and normalised (`owner/repo` too), with the folder it suggests. */
    validateClone: async (url: string, signal: AbortSignal) =>
      answer(await client.projects.validateCloneUrl(url, { signal }), "cloneUrl"),
    inspect: async (path: string, signal: AbortSignal) =>
      answer(await client.projects.inspect(path, { signal }), "inspection"),
  };
}

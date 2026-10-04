import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { CommandResult, Project, ProjectsResult } from "@ace/protocol";
import { projectProblem, type ProjectProblem } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
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
      : { code, message: "Couldn't reach the daemon. Check the connection and try again." };
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

/**
 * The project commands with their receipts checked, keeping the shared project list in step as
 * soon as the daemon answers (its push follows). Each rejects with `ProjectRefused` or the
 * client's error.
 */
export function useProjectCommands() {
  const client = useClient();
  const queryClient = useQueryClient();
  const organizer = useOrganizer();
  return useMemo(() => {
    const keep = (result: Added) => {
      rememberProject(queryClient, result.project);
      return result;
    };
    return {
      add: async (path: string) => keep(added(await client.projects.add({ path }))),
      create: async (input: CreateInput) => keep(added(await client.projects.create(input))),
      clone: async (input: { parent: string; name: string; url: string }, commandId: string) =>
        keep(added(await client.projects.clone(input, {}, commandId))),
      cancelClone: async (commandId: string) =>
        answer(await client.projects.cancelClone(commandId), "cancelled"),
      rename: async (workspaceId: string, name: string) => {
        const receipt = accepted(await client.projects.rename({ workspaceId, name }));
        if (receipt.workspace) rememberProject(queryClient, receipt.workspace);
      },
      remove: async (workspaceId: string, archiveThreads: boolean) => {
        accepted(await client.projects.remove({ workspaceId, archiveThreads }));
        forgetProject(queryClient, workspaceId);
        // Home stops filtering on a project that is gone.
        if (organizer.getState().project === workspaceId) organizer.setProject(null);
      },
    };
  }, [client, queryClient, organizer]);
}

export type ProjectCommands = ReturnType<typeof useProjectCommands>;

/** The folder reads, for the browser and the dialog's hints. */
export function projectReads(client: ClientApi) {
  return {
    home: async (signal: AbortSignal) => answer(await client.projects.home({ signal }), "home"),
    recent: async (signal: AbortSignal) =>
      answer(await client.projects.recentFolders(8, { signal }), "recentFolders"),
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
    inspect: async (path: string, signal: AbortSignal) =>
      answer(await client.projects.inspect(path, { signal }), "inspection"),
  };
}

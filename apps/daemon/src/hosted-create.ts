import {
  GitLabCreation,
  gitLabCreationWrites,
  ForgeMutationOutcome,
  type GitHubForge,
} from "@ace/forge";
import {
  ForgeHostedPrCreateCommand,
  type CommandResult,
  type ForgeRepository,
} from "@ace/protocol";
import type { ForgeBackends } from "./forge-backends.ts";

export type HostedCreationBackend = Pick<
  GitHubForge,
  "repository" | "repositoryMetadata" | "status" | "findPr" | "createPr" | "openPr"
>;
export async function gitLabCreationBackend(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<HostedCreationBackend> {
  const runner = await backends.hostRunner(cwd, repository, gitLabCreationWrites, signal);
  return new GitLabCreation({ repository, runner });
}
/** The target/head are already resolved and guarded by WorkspaceNewPr, never client-selected. */
export async function createHostedGitLabPr(
  raw: unknown,
  backend: HostedCreationBackend,
  signal: AbortSignal,
  allowed: () => boolean,
): Promise<Omit<CommandResult, "commandId">> {
  const input = ForgeHostedPrCreateCommand.parse(raw);
  // Details are separate writes and aren't admitted by the creation adapter yet.
  if (input.assignees.length || input.reviewers.length || input.milestone !== undefined)
    throw new Error("unsupported");
  if (!allowed()) throw new Error("forbidden");
  const head = { owner: input.head.owner, name: input.head.name };
  const found = await backend.findPr(input.head.branch, input.base, signal, head);
  if (!allowed()) throw new Error("forbidden");
  let pr;
  try {
    const fields = {
      branch: input.head.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
      labels: input.labels,
    };
    pr = found ?? (await backend.openPr(fields, signal, head));
  } catch (error) {
    if (error instanceof ForgeMutationOutcome) return { ok: false, error: "forge_write_uncertain" };
    throw error;
  }
  try {
    return {
      ok: true,
      pr,
      prStatus: await backend.status(pr.number, signal),
      ...(found ? { prExisting: true } : {}),
    };
  } catch {
    return {
      ok: true,
      pr,
      code: "forge_status_unavailable",
      ...(found ? { prExisting: true } : {}),
    };
  }
}

/** Shared create/metadata entrypoint for the thread publication path and prHead resolver. */
export async function hostedCreationBackend(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<HostedCreationBackend> {
  return repository.forge === "gitlab"
    ? gitLabCreationBackend(backends, cwd, repository, signal)
    : backends.backend(cwd, repository);
}

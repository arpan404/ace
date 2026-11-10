import { ForgeError, GitLabApi, GitLabChecks, gitLabChecksWrites } from "@ace/forge";
import { ForgeHostedChecksCommand, type ForgeRepository } from "@ace/protocol";
import { WorkspaceForgeChecks } from "./workspace-forge-checks.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";

/** Host routing for check detail and pipeline actions, independent of workspace hooks. */
export class HostedChecks {
  readonly #ctx: {
    backends: Pick<WorkspaceForgeContext["backends"], "hostRunner" | "backend" | "writer">;
  };
  readonly #execution = new WorkspaceForgeChecks();
  constructor(ctx: {
    backends: Pick<WorkspaceForgeContext["backends"], "hostRunner" | "backend" | "writer">;
  }) {
    this.#ctx = ctx;
  }

  async read(
    cwd: string,
    repository: ForgeRepository,
    checkRunId: number,
    jobId: number | undefined,
    signal: AbortSignal,
  ) {
    if (repository.forge === "github") {
      const backend = await this.#ctx.backends.backend(cwd, repository);
      return backend.checks.run(checkRunId, jobId, signal);
    }
    if (repository.forge !== "gitlab") throw new ForgeError("unsupported");
    const runner = await this.#ctx.backends.hostRunner(cwd, repository, [], signal);
    return new GitLabChecks(new GitLabApi({ repository, runner })).run(checkRunId, jobId, signal);
  }

  async execute(
    input: unknown,
    cwd: string,
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<void> {
    const command = ForgeHostedChecksCommand.parse(input);
    const repository = command.pr.repository;
    if (repository.forge !== "github" && repository.forge !== "gitlab")
      throw new ForgeError("unsupported");
    const backend =
      repository.forge === "github"
        ? await this.#ctx.backends.writer(cwd, repository)
        : {
            checks: new GitLabChecks(
              new GitLabApi({
                repository,
                runner: await this.#ctx.backends.hostRunner(
                  cwd,
                  repository,
                  gitLabChecksWrites,
                  signal,
                ),
              }),
            ),
          };
    return this.#execution.execute(command, backend, signal, allowed);
  }
}

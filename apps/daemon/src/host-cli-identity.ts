import {
  bktContext,
  bktIdentity,
  gitlabIdentity,
  isTeaHost,
  originIdentity,
  ForgeError,
  type CommandRunner,
  type HostApiCli,
} from "@ace/forge";
import type { ForgeRepository } from "@ace/protocol";
import { teaSourceIdentity } from "./tea-source-control.ts";

/** Bitbucket Cloud is the one Bitbucket ace reads; Data Center is another API (ADR 0118). */
const bitbucketCloud = "bitbucket.org";

/**
 * How a non-GitHub repository's CLI is reached: the CLI, the target its admitted requests name
 * (glab's host, tea's login, bkt's context) and its identity probe. A tea login or bkt context
 * is resolved before admission rules are built, never taken from the CLI's current default.
 */
export async function hostCliIdentity(
  runner: CommandRunner,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<{
  cli: HostApiCli;
  target: string;
  login: string | undefined;
  identify: (signal: AbortSignal) => Promise<string>;
}> {
  const forge = repository.forge;
  if (isTeaHost(forge)) {
    const tea = await teaSourceIdentity(runner, repository.host, signal);
    return { cli: "tea", target: tea.login, login: tea.login, identify: tea.identify };
  }
  if (forge === "bitbucket") {
    if (repository.host !== bitbucketCloud) throw new ForgeError("unsupported");
    const context = await bktContext(runner, repository.owner, signal);
    return {
      cli: "bkt",
      target: context,
      login: context,
      identify: (probe) => bktIdentity(runner, context, repository.owner, probe),
    };
  }
  if (forge === "origin")
    return {
      cli: "origin",
      target: repository.host,
      login: undefined,
      identify: (probe) => originIdentity(runner, probe),
    };
  if (forge === "gitlab")
    return {
      cli: "glab",
      target: repository.host,
      login: undefined,
      identify: (probe) => gitlabIdentity(runner, repository.host, probe),
    };
  throw new ForgeError("unsupported");
}

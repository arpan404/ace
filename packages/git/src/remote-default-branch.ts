import { z } from "zod";
import { textOutput } from "./cli.ts";
import { remoteNames } from "./remote-branches.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

const timeout = z.number().int().positive().max(2_147_483_647);

export interface RemoteDefaultBranchOptions {
  repo: string;
  /** The configured remote, not necessarily `origin`. */
  remote: string;
  /** Bounds the `ls-remote` query when the remote's `HEAD` was never recorded locally. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** `ref: refs/heads/main<TAB>HEAD` from `ls-remote --symref`. */
export function symrefHead(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * The branch the remote's `HEAD` names: the recorded `refs/remotes/<remote>/HEAD`, else one
 * bounded, non-interactive `ls-remote --symref`. Undefined when neither answers (no such remote,
 * unreachable, refused credentials, or a remote without a symbolic `HEAD`). Never prompts.
 */
export async function remoteDefaultBranch(
  repository: Repository,
  options: RemoteDefaultBranchOptions,
): Promise<string | undefined> {
  const deadline = timeout.safeParse(options.timeoutMs);
  if (!deadline.success) return undefined;
  const root = await repository.root(options.repo);
  if (!(await remoteNames(repository, root)).includes(options.remote)) return undefined;
  const recorded = await repository.cli.call(
    root,
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${options.remote}/HEAD`],
    { allowFailure: true, signal: options.signal },
  );
  if (recorded.exitCode === 0) {
    const name = textOutput(recorded);
    const prefix = `${options.remote}/`;
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  }
  try {
    // The transfer lease, credential helpers and a non-interactive SSH command come with the
    // CLI's own ls-remote, exactly as a push from this checkout would use them.
    const result = await repository.cli.lsRemote(
      root,
      ["ls-remote", "--symref", "--end-of-options", options.remote, "HEAD"],
      {
        allowFailure: true,
        captureBytes: 65_536,
        timeoutMs: deadline.data,
        signal: options.signal,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
    );
    return result.exitCode === 0 ? symrefHead(result.stdout.toString("utf8")) : undefined;
  } catch (error) {
    // A timeout or a refused transfer means "unknown"; the caller falls back. Cancellation isn't.
    options.signal?.throwIfAborted();
    if (error instanceof GitError && error.code !== "git_closed") return undefined;
    throw error;
  }
}

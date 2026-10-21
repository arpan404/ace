import type { VerifyFailure, VerifyRun } from "@ace/protocol";
import type { CheckShell } from "./check-process.ts";
import type { CheckTrees } from "./check-trees.ts";
import type { VerifyForge, VerifyGit } from "./ports.ts";
import { describeError } from "./run-errors.ts";
import { failure, type SettledState, type StepKind, type VerifyEvent } from "./run-state.ts";

/** Runs the project's worktree setup in a checkout; `started` says a setup script exists. */
export type SetupRunner = (input: {
  path: string;
  signal: AbortSignal;
  output(chunk: Buffer): void;
  started(): void;
}) => Promise<void>;

/** What a run reaches: the edges it works through. */
export interface RunPorts {
  git: VerifyGit;
  forge: VerifyForge;
  trees: CheckTrees;
  shell: CheckShell;
  setup: SetupRunner;
  fetchTimeoutMs: number;
}

/** One run as the runner drives it. */
export interface RunSession {
  current(): VerifyRun;
  project: string;
  report(event: VerifyEvent): void;
  line(text: string): void;
  /** Cancel or shutdown, honoured until GitHub merges begin. */
  signal: AbortSignal;
  /** Shutdown only: between GitHub merges, the run stops and a restart settles it. */
  stopping: AbortSignal;
  /** Whether the person who started the run may still merge. */
  allowed(): boolean;
}

/** How a run ended; `merging` means a shutdown left it for the next start to settle. */
export type RunOutcome = { state: SettledState; failure?: VerifyFailure } | { state: "merging" };

/** A failure the runner names; anything else thrown in a step reads as that step's failure. */
export class RunStop extends Error {
  readonly failure: VerifyFailure;
  constructor(value: VerifyFailure) {
    super(value.message);
    this.failure = value;
  }
}

const stepFailure: Record<StepKind, VerifyFailure["code"]> = {
  fetch: "fetch_failed",
  combine: "internal",
  setup: "setup_failed",
  check: "check_failed",
  merge: "merge_refused",
};

/** Run `work` as one step: running, then done (or `skipped` if it says so), else failed. */
export async function step<T>(
  session: RunSession,
  kind: StepKind,
  pr: number | undefined,
  work: () => Promise<T>,
  skipped: (value: T) => boolean = () => false,
): Promise<T> {
  const at = pr === undefined ? {} : { pr };
  session.report({ type: "step", kind, ...at, state: "running" });
  try {
    const value = await work();
    session.report({ type: "step", kind, ...at, state: skipped(value) ? "skipped" : "done" });
    return value;
  } catch (error) {
    session.report({ type: "step", kind, ...at, state: "failed" });
    if (error instanceof RunStop || session.signal.aborted) throw error;
    throw new RunStop(failure(stepFailure[kind], describeError(error), at));
  }
}

/** Setup, then the check command, in `path`; stops the run when either fails. */
export async function setupAndCheck(
  session: RunSession,
  ports: RunPorts,
  path: string,
): Promise<void> {
  await step(
    session,
    "setup",
    undefined,
    async () => {
      let ran = false;
      await ports.setup({
        path,
        signal: session.signal,
        output: (chunk) => session.line(chunk.toString("utf8").replace(/\n$/, "")),
        started: () => {
          ran = true;
        },
      });
      return ran;
    },
    (ran) => !ran,
  );
  const command = session.current().command;
  await step(session, "check", undefined, async () => {
    session.line(`$ ${command}`);
    const result = await ports.shell({
      command,
      cwd: path,
      line: (text) => session.line(text),
      signal: session.signal,
    });
    session.report({ type: "exit", code: result.code });
    session.signal.throwIfAborted();
    if (result.code !== 0)
      throw new RunStop(
        failure(
          "check_failed",
          result.reason === "timeout"
            ? `${command} ran too long and was stopped`
            : result.code === null
              ? `${command} was stopped (${result.reason})`
              : `${command} exited with ${result.code}`,
        ),
      );
  });
}

export async function prRemote(session: RunSession, ports: RunPorts): Promise<string> {
  const target = session.current().target;
  const repository =
    target.kind === "check" ? target.pr.pr.repository : target.prs[0]?.pr.repository;
  if (!repository) throw new RunStop(failure("internal", "No pull request to verify"));
  return ports.forge.remote(session.project, repository, session.signal);
}

/** Fetch a PR's head and refuse one that is no longer the head the person selected. */
export async function fetchHead(
  session: RunSession,
  ports: RunPorts,
  remote: string,
  number: number,
  headSha: string,
): Promise<void> {
  const head = await ports.git.nonExecuting(() =>
    ports.git.fetchPrHead({
      repo: session.project,
      remote,
      number,
      timeoutMs: ports.fetchTimeoutMs,
      signal: session.signal,
    }),
  );
  if (head !== headSha)
    throw new RunStop(
      failure("head_moved", `#${number} has new commits; look again and retry`, { pr: number }),
    );
}

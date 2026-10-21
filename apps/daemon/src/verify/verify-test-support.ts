import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitService } from "@ace/git";
import type {
  ForgePrRef,
  VerifyChanged,
  VerifyRun,
  VerifyTarget,
  WorkspaceId,
} from "@ace/protocol";
import { assertTestGitDirectory } from "@ace/provider-kit/test-isolation";
import { runSetupScript } from "../creation-setup.ts";
import { ProjectStorage } from "../project-storage.ts";
import { Store } from "../store.ts";
import { supervisedCheckShell } from "./check-process.ts";
import type { VerifyForge, VerifyMergeOutcome } from "./ports.ts";
import { projectCheck } from "./project-check.ts";
import { Verify } from "./verify-service.ts";

const exec = promisify(execFile);
export const repository = {
  host: "github.com",
  forge: "github",
  owner: "octo",
  name: "ace",
} as const satisfies ForgePrRef["repository"];

export async function inRepo(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", assertTestGitDirectory(cwd), ...args])).stdout.trim();
}

/** GitHub as the test scripts it: merges are recorded and answered as configured. */
export class FakeVerifyForge implements VerifyForge {
  merges: { pr: number; headSha: string; method: string }[] = [];
  refuse = new Set<number>();
  /** Refused once (GitHub settling the merge before), then merged. */
  refuseOnce = new Set<number>();
  lose = new Set<number>();
  stackedPrs = new Set<number>();
  mergedOnGitHub = new Set<number>();
  bases = new Map<number, string>();
  /** Merges of these PRs wait until the test releases them. */
  private waits = new Map<number, Promise<void>>();
  hold(pr: number): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waits.set(pr, promise);
    return resolve;
  }
  async remote() {
    return "origin";
  }
  async base(_project: string, pr: ForgePrRef) {
    return this.bases.get(pr.number) ?? "main";
  }
  async stacked(_project: string, _id: WorkspaceId, _repo: unknown, numbers: readonly number[]) {
    return numbers.filter((number) => this.stackedPrs.has(number));
  }
  async merge(input: Parameters<VerifyForge["merge"]>[0]): Promise<VerifyMergeOutcome> {
    this.merges.push({ pr: input.pr.number, headSha: input.headSha, method: input.method });
    await this.waits.get(input.pr.number);
    if (this.refuseOnce.delete(input.pr.number))
      return { outcome: "refused", message: "Base branch was modified" };
    if (this.refuse.has(input.pr.number))
      return { outcome: "refused", message: "Required reviews are missing" };
    if (this.lose.has(input.pr.number)) return { outcome: "uncertain" };
    this.mergedOnGitHub.add(input.pr.number);
    return { outcome: "merged" };
  }
  async merged(_project: string, _repo: unknown, numbers: readonly number[]) {
    return numbers.filter((number) => this.mergedOnGitHub.has(number));
  }
}

/**
 * A project checkout with a bare `origin` that advertises PR heads as `refs/pull/N/head`, a
 * temporary event store, and Verify over real Git and real check processes. Only GitHub is
 * scripted.
 */
export async function verifyFixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "ace-verify-")));
  const project = join(scratch, "project");
  const origin = join(scratch, "origin.git");
  await exec("git", ["init", "-q", "-b", "main", project]);
  await inRepo(project, "config", "user.name", "Test");
  await inRepo(project, "config", "user.email", "test@ace.local");
  await writeFile(join(project, "file.txt"), "base\n");
  await inRepo(project, "add", ".");
  await inRepo(project, "commit", "-qm", "Initial");
  await exec("git", ["clone", "-q", "--bare", "--", project, origin]);
  await inRepo(project, "remote", "add", "origin", origin);
  await inRepo(project, "fetch", "-q", "origin");
  const store = new Store(join(scratch, "events.sqlite"));
  let clock = 1_000;
  const now = () => ++clock;
  const workspaceId = store.createWorkspace(project, "Project");
  const projects = new ProjectStorage(store, now);
  const git = new GitService({ transportProtocols: ["file"] });
  const forge = new FakeVerifyForge();
  const changes: VerifyRun[] = [];
  const waiters = new Set<() => void>();
  let ids = 0;
  const open = () => {
    const verify = new Verify({
      store,
      git,
      forge,
      shell: supervisedCheckShell({ graceMs: 1_000 }),
      setup: ({ path, signal, output, started }) =>
        runSetupScript(git, path, signal, { stderr: output }, started),
      root: join(scratch, "data", "verify"),
      now,
      id: () => `run-${++ids}`,
      project: (id) => projectCheck(store, id),
      recoveryRetryMs: 10,
      mergeRetryMs: 1,
    });
    verify.subscribe((change: VerifyChanged) => {
      changes.push(change.run);
      for (const wake of waiters) wake();
    });
    return verify;
  };
  const verify = open();
  /** The newest copy of a run once `done` holds for it. */
  const until = (id: string, done: (run: VerifyRun) => boolean) =>
    new Promise<VerifyRun>((resolve) => {
      const check = () => {
        const run = changes.findLast((entry) => entry.id === id);
        if (run && done(run)) {
          waiters.delete(check);
          resolve(run);
        }
      };
      waiters.add(check);
      check();
    });
  return {
    scratch,
    project,
    origin,
    store,
    git,
    forge,
    verify,
    workspaceId,
    changes,
    open,
    until,
    settled: (id: string) =>
      until(id, (run) =>
        ["passed", "failed", "merged", "stopped", "cancelled", "interrupted"].includes(run.state),
      ),
    setCommand: (checkCommand: string | undefined) =>
      projects.update(workspaceId, "Project", {
        defaults: checkCommand === undefined ? {} : { checkCommand },
      }),
    /** Commit `files` on a branch off `from` and advertise it as PR `number`; its head. */
    async pr(number: number, files: Record<string, string>, from = "main") {
      await inRepo(project, "switch", "-q", "-c", `pr-${number}`, from);
      for (const [name, text] of Object.entries(files)) await writeFile(join(project, name), text);
      await inRepo(project, "add", ".");
      await inRepo(project, "commit", "-qm", `PR ${number}`);
      const head = await inRepo(project, "rev-parse", "HEAD");
      await inRepo(project, "push", "-q", "origin", `HEAD:refs/pull/${number}/head`);
      await inRepo(project, "switch", "-q", "main");
      return head;
    },
    check: (number: number, headSha: string): VerifyTarget => ({
      kind: "check",
      pr: { pr: { repository, number }, headSha },
    }),
    merge: (
      prs: readonly (readonly [number, string])[],
      method: "merge" | "squash" | "rebase" = "squash",
    ): VerifyTarget => ({
      kind: "merge",
      prs: prs.map(([number, headSha]) => ({ pr: { repository, number }, headSha })),
      method,
    }),
    /** Every worktree Git knows besides the project's own. */
    async trees() {
      const listed = await inRepo(project, "worktree", "list", "--porcelain");
      return listed
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((path) => path !== project);
    },
    async close() {
      await verify.close();
      await git.close();
      await store.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

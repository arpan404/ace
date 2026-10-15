import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { GitService } from "@ace/git";
import { Command, CommandPayload } from "@ace/protocol";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { pushWorkspace } from "./workspace-push.ts";
import { actionErrorCode } from "./action-errors.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", ["-C", cwd, ...args])).stdout.trim();

/** The fixture checkout with one commit, its `origin` (a GitHub fork) a local bare repository. */
async function checkout() {
  const f = await forgeIdentityFixture();
  await git(f.root, "config", "user.name", "Test");
  await git(f.root, "config", "user.email", "test@example.invalid");
  await writeFile(join(f.root, "tracked"), "first");
  await git(f.root, "add", "tracked");
  await git(f.root, "commit", "-qm", "Initial");
  const fork = join(f.root, "fork.git");
  await run("git", ["init", "--bare", "-q", fork]);
  await git(
    f.root,
    "config",
    `url.${pathToFileURL(fork).href}.insteadOf`,
    "https://github.com/fork/ace.git",
  );
  await git(f.root, "push", "-q", "origin", "main");
  return { f, fork };
}

async function commit(root: string, content: string) {
  await writeFile(join(root, "tracked"), content);
  await git(root, "commit", "-qam", content);
  return git(root, "rev-parse", "HEAD");
}

const push = CommandPayload.parse({ type: "git.push", threadId: "identity-thread" });
if (push.type !== "git.push") throw new Error("Expected a push payload");
const forkRepository = { forge: "github", host: "github.com", owner: "fork", name: "ace" } as const;

test("a pull request checkout's push updates the PR's head branch, never an ace branch", async () => {
  const { f, fork } = await checkout();
  const service = new GitService({
    transportProtocols: ["file"],
    credentialHelperLookup: async () => [],
  });
  try {
    await git(f.root, "push", "-q", "origin", "main:refs/heads/feature");
    await git(f.root, "switch", "-qc", "ace/0123456789abcdef01234567");
    const head = await commit(f.root, "review fix");
    await pushWorkspace(service, f.sourceControl, f.root, push, () => true, {
      headBranch: "feature",
      headRepository: forkRepository,
    });
    expect(await git(fork, "rev-parse", "refs/heads/feature")).toBe(head);
    expect(await git(fork, "for-each-ref", "--format=%(refname)", "refs/heads/ace")).toBe("");
    for (const headRepository of [null, { ...forkRepository, owner: "someone-else" }]) {
      const refused = await pushWorkspace(service, f.sourceControl, f.root, push, () => true, {
        headBranch: "feature",
        headRepository,
      }).then(
        () => "pushed",
        (error: unknown) => actionErrorCode(error),
      );
      expect(refused).toBe("git_pr_head_unavailable");
    }
    expect(await git(fork, "for-each-ref", "--format=%(refname)", "refs/heads/ace")).toBe("");
  } finally {
    await service.close();
    await f.close();
  }
});

test("a push behind its remote returns the remote head, and a force leased to it lands", async () => {
  const { f, fork } = await checkout();
  await f.runtime.close();
  const runtime = new WorkspaceRuntime(f.store, f.root, () => 1000, {
    sourceControl: f.sourceControl,
    git: { transportProtocols: ["file"], credentialHelperLookup: async () => [] },
  });
  try {
    // A collaborator's commit reaches the remote; the person's checkout has seen it.
    await git(f.root, "switch", "-qc", "collaborator");
    const theirs = await commit(f.root, "collaborator");
    await git(f.root, "push", "-q", "origin", "collaborator:main");
    await git(f.root, "switch", "-q", "main");
    await git(f.root, "fetch", "-q", "origin");
    const mine = await commit(f.root, "mine");
    const execute = (id: string, extra: object = {}) =>
      runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: { type: "git.push", threadId: f.thread.id, ...extra },
        }),
      );
    expect(await execute("push")).toMatchObject({
      ok: false,
      error: "git_push_rejected",
      remoteHead: theirs,
    });
    expect(await git(fork, "rev-parse", "refs/heads/main")).toBe(theirs);
    expect(await execute("force", { force: { lease: theirs } })).toMatchObject({ ok: true });
    expect(await git(fork, "rev-parse", "refs/heads/main")).toBe(mine);
  } finally {
    await runtime.close();
    await f.close();
  }
});

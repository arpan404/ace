import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId, type WorktreeBase } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { startServer } from "./server.ts";
import { token } from "./socket-test-support.ts";
import { command, connect, git, repository } from "./thread-creation-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const run = async (cwd: string, ...args: string[]) =>
  (await git("git", ["-C", cwd, ...args])).stdout.trim();

/**
 * A daemon whose workspace is a checkout of a bare `origin` (with `origin/main` fetched and set
 * as main's upstream), plus a second clone that publishes new commits to that origin.
 */
async function daemonWithOrigin() {
  const h = transitionHarness({
    prepareWorkspace: async () => {
      throw new Error("Worktree threads must be prepared before acceptance");
    },
  });
  cleanups.push(() => h.close());
  await h.engine.ready();
  await repository(h.home);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "ace-worktree-base-")));
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  const origin = join(scratch, "origin.git");
  const publisher = join(scratch, "publisher");
  await git("git", ["clone", "--quiet", "--bare", "--", h.home, origin]);
  await run(h.home, "remote", "add", "origin", origin);
  await run(h.home, "fetch", "--quiet", "origin");
  await run(h.home, "branch", "--quiet", "--set-upstream-to=origin/main", "main");
  await git("git", ["clone", "--quiet", "--", origin, publisher]);
  await run(publisher, "config", "user.name", "Publisher");
  await run(publisher, "config", "user.email", "publisher@ace.local");
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000);
  cleanups.push(() => runtime.close());
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
  });
  cleanups.push(() => server.close());
  const client = await connect(server.url);
  cleanups.push(() => client.close());
  return {
    h,
    runtime,
    home: h.home,
    origin,
    scratch,
    /** Commit on `branch` in the publisher and push it to origin; returns the new commit. */
    async publish(branch: string, message: string) {
      await run(publisher, "switch", "--quiet", "-C", branch);
      await run(publisher, "commit", "--quiet", "--allow-empty", "-m", message);
      await run(publisher, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
      return run(publisher, "rev-parse", "HEAD");
    },
    /** `thread.create` in worktree mode from `base`, sending `baseBranch` as clients do. */
    create(id: string, base: WorktreeBase) {
      return command(client, id, {
        type: "thread.create",
        threadId: ThreadId.parse(id),
        workspaceId: h.workspace,
        provider: "codex",
        mode: "worktree",
        base,
        baseBranch: base.remote ? `${base.remote}/${base.ref}` : base.ref,
        input: [{ type: "text", text: "Start here" }],
      });
    },
    details(id: string) {
      return h.store.getThread(ThreadId.parse(id))?.details;
    },
  };
}

/** The registered worktrees' paths. */
async function worktreePaths(home: string) {
  return (await run(home, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
}

/** What the person owns in their checkout: HEAD, index, local branches and their upstreams. */
async function checkout(home: string) {
  return {
    head: await readFile(join(home, ".git", "HEAD"), "utf8"),
    index: await readFile(join(home, ".git", "index")),
    branches: await run(
      home,
      "for-each-ref",
      "--format=%(refname) %(objectname) %(upstream)",
      "refs/heads",
    ),
  };
}

test("a worktree based on origin/main starts at origin's newer commit and leaves the checkout alone", async () => {
  const d = await daemonWithOrigin();
  const localMain = await run(d.home, "rev-parse", "main");
  const newer = await d.publish("main", "Newer on origin");
  const before = await checkout(d.home);

  expect(await d.create("from-origin", { ref: "main", remote: "origin" })).toMatchObject({
    ok: true,
  });

  const details = d.details("from-origin");
  expect(details).toMatchObject({
    baseBranch: "origin/main",
    base: { ref: "main", remote: "origin", head: newer, fetch: "fetched" },
  });
  const worktree = details?.worktree ?? "";
  expect(await run(worktree, "rev-parse", "HEAD")).toBe(newer);
  // Its own branch, with no upstream: the first push sets a same-named one, never main.
  expect(details?.branch).toMatch(/^ace\//);
  expect(
    await run(worktree, "for-each-ref", "--format=%(upstream)", `refs/heads/${details?.branch}`),
  ).toBe("");
  expect(await run(d.home, "rev-parse", "main")).toBe(localMain);
  // Only the thread's own `ace/` branch is new.
  const after = await checkout(d.home);
  const personal = after.branches
    .split("\n")
    .filter((line) => !line.startsWith("refs/heads/ace/"))
    .join("\n");
  expect({ ...after, branches: personal }).toEqual(before);
});

test("a worktree can start from a branch only the remote has, never fetched before", async () => {
  const d = await daemonWithOrigin();
  const remoteOnly = await d.publish("feature/remote-only", "Remote work");

  expect(
    await d.create("remote-only", { ref: "feature/remote-only", remote: "origin" }),
  ).toMatchObject({ ok: true });

  const details = d.details("remote-only");
  expect(details?.base).toEqual({
    ref: "feature/remote-only",
    remote: "origin",
    head: remoteOnly,
    fetch: "fetched",
  });
  expect(await run(details?.worktree ?? "", "rev-parse", "HEAD")).toBe(remoteOnly);
  expect(await run(d.home, "for-each-ref", "refs/heads/feature")).toBe("");
});

test("a worktree based on a local branch starts at that branch without fetching", async () => {
  const d = await daemonWithOrigin();
  const tree = await run(d.home, "rev-parse", "HEAD^{tree}");
  const local = await run(d.home, "commit-tree", tree, "-p", "HEAD", "-m", "Local work");
  await run(d.home, "update-ref", "refs/heads/local-work", local);
  const cachedOrigin = await run(d.home, "rev-parse", "refs/remotes/origin/main");
  await d.publish("main", "Not fetched");

  expect(await d.create("local", { ref: "local-work" })).toMatchObject({ ok: true });

  const details = d.details("local");
  expect(details).toMatchObject({
    baseBranch: "local-work",
    base: { ref: "local-work", head: local },
  });
  expect(details?.base).not.toHaveProperty("fetch");
  expect(await run(details?.worktree ?? "", "rev-parse", "HEAD")).toBe(local);
  expect(await run(d.home, "rev-parse", "refs/remotes/origin/main")).toBe(cachedOrigin);
});

test("an unreachable remote falls back to its last fetched copy, and fails when there is none", async () => {
  const d = await daemonWithOrigin();
  const cached = await run(d.home, "rev-parse", "refs/remotes/origin/main");
  await d.publish("main", "Unseen");
  await d.publish("never-fetched", "Unseen branch");
  await run(d.home, "remote", "set-url", "origin", join(d.scratch, "offline.git"));

  expect(await d.create("offline-cached", { ref: "main", remote: "origin" })).toMatchObject({
    ok: true,
  });
  const details = d.details("offline-cached");
  expect(details?.base).toEqual({
    ref: "main",
    remote: "origin",
    head: cached,
    fetch: "unreachable",
  });
  expect(await run(details?.worktree ?? "", "rev-parse", "HEAD")).toBe(cached);

  const worktrees = await worktreePaths(d.home);
  expect(
    await d.create("offline-missing", { ref: "never-fetched", remote: "origin" }),
  ).toMatchObject({ ok: false, error: "worktree_base_unreachable" });
  expect(d.details("offline-missing")).toBeUndefined();
  expect(await worktreePaths(d.home)).toEqual(worktrees);
  // The repository is still usable afterwards.
  expect(await d.create("offline-again", { ref: "main", remote: "origin" })).toMatchObject({
    ok: true,
  });
});

test("a base that doesn't exist locally or on a reachable remote fails as not found", async () => {
  const d = await daemonWithOrigin();
  const refs = await run(d.home, "for-each-ref");

  expect(await d.create("no-local", { ref: "no-such-branch" })).toMatchObject({
    ok: false,
    error: "worktree_base_not_found",
  });
  expect(await d.create("no-remote", { ref: "no-such-branch", remote: "origin" })).toMatchObject({
    ok: false,
    error: "worktree_base_not_found",
  });
  expect(d.details("no-local")).toBeUndefined();
  expect(d.details("no-remote")).toBeUndefined();
  expect(await run(d.home, "for-each-ref")).toBe(refs);
});

test("the branch list tells local branches from the remote's, with how far main is behind after a fetch", async () => {
  const d = await daemonWithOrigin();
  await d.publish("main", "Newer on origin");
  await d.publish("release/0.9", "Release branch");
  expect(await d.create("fetches", { ref: "main", remote: "origin" })).toMatchObject({ ok: true });
  expect(await d.create("fetches-release", { ref: "release/0.9", remote: "origin" })).toMatchObject(
    { ok: true },
  );

  const listed = await d.runtime.read({
    type: "workspace.request",
    requestId: "branches",
    operation: { op: "branches.list", workspaceId: d.h.workspace },
  });

  expect(listed.result).toMatchObject({
    kind: "branches",
    truncated: false,
    defaultBranch: "main",
    branches: expect.arrayContaining(["main", "origin/main", "origin/release/0.9"]),
  });
  const refs = listed.result?.kind === "branches" ? (listed.result.refs ?? []) : [];
  expect(refs).toEqual(
    expect.arrayContaining([
      { name: "main", upstream: "origin/main", ahead: 0, behind: 1 },
      { name: "main", remote: "origin" },
      { name: "release/0.9", remote: "origin" },
    ]),
  );
  expect(refs.filter((ref) => ref.remote === "origin").map((ref) => ref.name)).toEqual([
    "main",
    "release/0.9",
  ]);
});

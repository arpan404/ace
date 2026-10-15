import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Thread, ThreadId } from "@ace/protocol";
import { fakeGh, pr, sha, threads, type Fixtures } from "@ace/forge/testing";
import { ForgeStore } from "@ace/forge";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const threadId = ThreadId.parse("create-thread");
const origin = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
const upstream = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const lookup = (repo: string, head: string, base: string) =>
  `repos/${repo}/pulls?${new URLSearchParams({ state: "open", head, base, per_page: "2" })}`;
const metadata = (defaultBranch: string, parent?: { owner: string; defaultBranch: string }) => ({
  body: {
    name: "ace",
    owner: { login: "octo" },
    default_branch: defaultBranch,
    fork: parent !== undefined,
    ...(parent
      ? {
          parent: {
            name: "ace",
            owner: { login: parent.owner },
            default_branch: parent.defaultBranch,
          },
        }
      : {}),
  },
});
const opened = (number: number, repo = "octo/ace") => ({
  ...pr,
  number,
  html_url: `https://github.com/${repo}/pull/${number}`,
  head: { sha, ref: "feature" },
});

/** The reads that follow a create: the new PR's status, with nothing to report yet. */
function statusOf(repo: string, number: number): Fixtures {
  return {
    [`repos/${repo}/pulls/${number}`]: [{ body: opened(number, repo) }],
    [`repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`]: [
      { body: { check_runs: [] } },
    ],
    [`repos/${repo}/commits/${sha}/statuses?per_page=100`]: [{ body: [] }],
    [`repos/${repo}/pulls/${number}/comments?per_page=100`]: [{ body: [] }],
    [`repos/${repo}/issues/${number}/comments?per_page=100`]: [{ body: [] }],
    [`repos/${repo}/pulls/${number}/reviews?per_page=100`]: [{ body: [] }],
    graphql: [{ body: threads() }],
  };
}

async function environment(records: Fixtures, linkMerged = false) {
  const gh = await fakeGh(records);
  const root = await mkdtemp(join(tmpdir(), "ace-pr-create-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: threadId,
    workspaceId,
    title: "Create",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  if (linkMerged)
    store.atomic((db) =>
      new ForgeStore(db).link({ threadId, pr: { repository: origin, number: 7 } }),
    );
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  return {
    gh,
    store,
    create(base = "main") {
      return runtime.execute(
        Command.parse({
          id: "create",
          deviceId: "device",
          payload: {
            type: "forge.pr.create",
            threadId,
            repository: origin,
            input: {
              branch: "feature",
              // What a client guesses for a thread with no recorded base.
              base,
              title: "Feature",
              summary: "Adds the feature",
              draft: false,
              template: { title: "{{title}}", body: "{{summary}}" },
            },
          },
        }),
      );
    },
    async posts() {
      return (await gh.requests()).filter((request) => request.path.endsWith("/pulls"));
    },
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("the base is the repo's default branch when the thread records none", async () => {
  const app = await environment({
    "repos/octo/ace": [metadata("master")],
    [lookup("octo/ace", "octo:feature", "master")]: [{ body: [] }],
    "repos/octo/ace/pulls": [{ status: 201, body: opened(12) }],
    ...statusOf("octo/ace", 12),
  });
  try {
    expect(await app.create("main")).toMatchObject({ ok: true, pr: { number: 12 } });
    expect((await app.posts()).map((request) => request.body)).toEqual([
      expect.objectContaining({ head: "feature", base: "master" }),
    ]);
  } finally {
    await app.close();
  }
});

test("a fork PR targets upstream and links the upstream PR", async () => {
  const app = await environment({
    "repos/octo/ace": [metadata("main", { owner: "acme", defaultBranch: "develop" })],
    [lookup("acme/ace", "octo:feature", "develop")]: [{ body: [] }],
    "repos/acme/ace/pulls": [{ status: 201, body: opened(40, "acme/ace") }],
    ...statusOf("acme/ace", 40),
  });
  try {
    expect(await app.create()).toMatchObject({
      ok: true,
      pr: { repository: upstream, number: 40 },
    });
    const posts = await app.posts();
    expect(posts.map((request) => [request.path, request.body])).toEqual([
      ["repos/acme/ace/pulls", expect.objectContaining({ head: "octo:feature", base: "develop" })],
    ]);
    expect(app.store.getThread(threadId)?.details?.linkedPrs).toContainEqual(
      expect.objectContaining({ number: 40, repo: upstream }),
    );
  } finally {
    await app.close();
  }
});

test("Create PR after a merged PR opens a new one", async () => {
  const merged = { ...opened(7), state: "closed", merged: true, base: { ref: "main" } };
  const app = await environment(
    {
      "repos/octo/ace": [metadata("main")],
      // Every state still lists the merged PR; only open PRs decide whether to create.
      [`repos/octo/ace/pulls?${new URLSearchParams({ state: "all", head: "octo:feature", base: "main", per_page: "2" })}`]:
        [{ body: [merged] }],
      [lookup("octo/ace", "octo:feature", "main")]: [{ body: [] }],
      "repos/octo/ace/pulls": [{ status: 201, body: opened(13) }],
      ...statusOf("octo/ace", 13),
    },
    true,
  );
  try {
    expect(await app.create()).toMatchObject({ ok: true, pr: { number: 13 } });
    expect(await app.posts()).toHaveLength(1);
    expect(
      app.store.getThread(threadId)?.details?.linkedPrs?.map((linked) => linked.number),
    ).toEqual([13, 7]);
  } finally {
    await app.close();
  }
});

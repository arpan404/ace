import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Thread, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceForge } from "./workspace-forge.ts";
import type { CommandRunner } from "@ace/forge";

const repo = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
const signal = () => new AbortController().signal;
async function fixture(runner: CommandRunner, seed: (store: Store) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-pr-links-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  for (const id of ["first", "second"])
    store.appendEvents(ThreadId.parse(id), [
      {
        type: "thread.created",
        thread: Thread.parse({
          id,
          workspaceId,
          title: id,
          provider: "codex",
          status: { state: "new" },
          createdAt: 1,
          updatedAt: 1,
        }),
      },
    ]);
  seed(store);
  const forge = new WorkspaceForge(
    store,
    {
      async repositoryInfo() {
        throw new Error("Offline git boundary");
      },
    },
    () => 1000,
    () => runner,
  );
  return {
    store,
    forge,
    async close() {
      forge.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("state refresh batches all PRs per repo across threads, retains missing links as closed and publishes live details", async () => {
  const calls: string[] = [];
  const f = await fixture(async (request) => {
    calls.push(request.args[1] ?? "");
    if (request.args[1] !== "graphql") return { code: 1, stdout: "offline", truncated: false };
    return {
      code: 0,
      truncated: false,
      stdout: `HTTP/1.1 200 OK\n\n${JSON.stringify({
        data: {
          repository: {
            pr283: {
              number: 283,
              title: "Merged work",
              url: "https://github.com/octo/ace/pull/283",
              state: "MERGED",
              isDraft: false,
              updatedAt: "2026-10-09T00:00:00Z",
            },
            pr284: {
              number: 284,
              title: "Draft follow-up",
              url: "https://github.com/octo/ace/pull/284",
              state: "OPEN",
              isDraft: true,
              updatedAt: "2026-10-09T00:00:00Z",
            },
            pr285: null,
          },
        },
      })}`,
    };
  });
  const first = Thread.parse(f.store.getThread(ThreadId.parse("first"))).id;
  const second = Thread.parse(f.store.getThread(ThreadId.parse("second"))).id;
  try {
    for (const number of [283, 284, 285])
      await f.forge.link(first, "/fake", { repository: repo, number });
    await f.forge.link(second, "/fake", { repository: repo, number: 283 });
    await f.forge.refresh([
      { id: first, cwd: "/fake" },
      { id: second, cwd: "/fake" },
    ]);
    expect(calls.filter((path) => path === "graphql")).toHaveLength(1);
    expect(f.store.getThread(first)?.details?.linkedPrs).toMatchObject([
      { number: 285, state: "closed", deleted: true },
      { number: 284, state: "draft", title: "Draft follow-up" },
      { number: 283, state: "merged", title: "Merged work" },
    ]);
    expect(f.store.getThread(second)?.details?.linkedPrs).toMatchObject([
      { number: 283, state: "merged" },
    ]);
  } finally {
    await f.close();
  }
});

test("a known missing PR is refused, while an unauthenticated forge keeps an unverified link", async () => {
  const f = await fixture(async (request) => ({
    code: 1,
    truncated: false,
    stdout: `HTTP/1.1 ${request.args[1]?.endsWith("/283") ? "404 Not Found" : "401 Unauthorized"}\n\n{}`,
  }));
  const id = Thread.parse(f.store.getThread(ThreadId.parse("first"))).id;
  try {
    expect(
      await f.forge.agent(
        id,
        "/fake",
        { op: "thread.link_pr", url: "https://github.com/octo/ace/pull/283" },
        signal(),
      ),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(f.store.getThread(id)?.details?.linkedPrs ?? []).toEqual([]);
    expect(
      await f.forge.agent(
        id,
        "/fake",
        { op: "thread.link_pr", number: 284, repo: "octo/ace" },
        signal(),
      ),
    ).toMatchObject({ ok: true });
    expect(f.store.getThread(id)?.details?.linkedPrs).toMatchObject([
      { number: 284, unverified: true },
    ]);
  } finally {
    await f.close();
  }
});

test("old agent metadata links become visible beside existing forge links on startup", async () => {
  const f = await fixture(
    async () => ({ code: 1, stdout: "offline", truncated: false }),
    (store) =>
      store.atomic((db) => {
        db.exec(
          "CREATE TABLE forge_links(thread_id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE agent_thread_metadata(thread_id TEXT PRIMARY KEY,pr_url TEXT,snoozed_until INTEGER)",
        );
        db.prepare("INSERT INTO forge_links VALUES (?,?)").run(
          "first",
          JSON.stringify({ threadId: "first", pr: { repository: repo, number: 283 } }),
        );
        db.prepare("INSERT INTO agent_thread_metadata VALUES (?,?,NULL)").run(
          "first",
          "https://github.com/octo/ace/pull/284",
        );
      }),
  );
  try {
    expect(f.store.getThread(ThreadId.parse("first"))?.details?.linkedPrs).toMatchObject([
      { number: 284 },
      { number: 283 },
    ]);
    expect(
      await f.forge.agent(ThreadId.parse("first"), "/fake", { op: "thread.list_prs" }, signal()),
    ).toMatchObject({ ok: true, data: { linkedPrs: [{ number: 284 }, { number: 283 }] } });
  } finally {
    await f.close();
  }
});

test("a late offline duplicate cannot overwrite a verified association", async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const f = await fixture(async (request) => {
    const path = request.args[1] ?? "";
    if (path.endsWith("/pulls/283") && ++requests === 1) {
      waiting.resolve();
      await release.promise;
      return { code: 1, stdout: "offline", truncated: false };
    }
    let body: unknown = [];
    if (path.endsWith("/pulls/283"))
      body = {
        number: 283,
        node_id: "PR_283",
        title: "Verified PR",
        html_url: "https://github.com/octo/ace/pull/283",
        state: "open",
        draft: true,
        head: { sha: "a".repeat(40), ref: "topic" },
      };
    if (path.includes("/check-runs?")) body = { check_runs: [] };
    if (path === "graphql")
      body = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      };
    return { code: 0, stdout: `HTTP/1.1 200 OK\n\n${JSON.stringify(body)}`, truncated: false };
  });
  const id = ThreadId.parse("first");
  try {
    const late = f.forge.link(id, "/fake", { repository: repo, number: 283 });
    await waiting.promise;
    await f.forge.link(id, "/fake", { repository: repo, number: 283 });
    release.resolve();
    await late;
    expect(f.store.getThread(id)?.details?.linkedPrs).toEqual([
      {
        number: 283,
        repo,
        url: "https://github.com/octo/ace/pull/283",
        title: "Verified PR",
        state: "draft",
        updatedAt: 1000,
      },
    ]);
  } finally {
    release.resolve();
    await f.close();
  }
});

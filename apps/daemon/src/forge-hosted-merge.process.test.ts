import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Thread, type CommandPayload } from "@ace/protocol";
import {
  fakeGh,
  mergeStateResponse,
  standard,
  pr,
  repository,
  sha,
  nextSha,
  threads,
  type Fixtures,
} from "@ace/forge/testing";
import { ForgeStore } from "@ace/forge";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const path = "repos/octo/ace/pulls/7";
const mergePath = `${path}/merge`;
const ref = { repository, number: 7 };
const hosted = {
  ...pr,
  body: "Context",
  user: { login: "octo" },
  labels: [],
  base: { ref: "main", sha: nextSha },
  head: { ...pr.head, repo: { owner: { login: "octo" }, name: "ace" } },
  requested_reviewers: [],
  commits: 1,
  changed_files: 1,
};
const merged = { ...hosted, state: "closed", merged: true, merged_at: "2026-10-11" };

function fixtures(): Fixtures {
  const value = standard();
  value[path] = [{ body: hosted }];
  value["merge-state-read"] = [mergeStateResponse()];
  value.graphql = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              ...threads().data.repository.pullRequest,
              reviewDecision: null,
              headRefOid: sha,
            },
          },
        },
      },
    },
  ];
  return value;
}

/** A project whose PR #7 no thread is linked to, unless `linkedThread` names one. */
async function environment(records: Fixtures, linkedThread?: string) {
  const gh = await fakeGh(records);
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-merge-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const database = join(root, "events.sqlite");
  let store = new Store(database);
  const workspaceId = store.createWorkspace(root, "Project");
  if (linkedThread) {
    const thread = Thread.parse({
      id: linkedThread,
      workspaceId,
      title: "Linked",
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    store.atomic((db) => new ForgeStore(db).link({ threadId: linkedThread, pr: ref }));
  }
  const create = () =>
    new WorkspaceRuntime(store, root, () => 1000, {
      forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
    });
  let runtime = create();
  const merge = (method: "merge" | "squash" | "rebase" = "squash"): CommandPayload => ({
    type: "forge.hosted.merge",
    workspaceId,
    pr: ref,
    headSha: sha,
    method,
  });
  return {
    gh,
    merge,
    command(id: string, payload: CommandPayload = merge()) {
      return runtime.execute(Command.parse({ id, deviceId: "device", payload }), () => true);
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(database);
      runtime = create();
    },
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function merges(gh: Awaited<ReturnType<typeof fakeGh>>) {
  return (await gh.requests()).filter(
    (request) => request.path === mergePath && request.args.includes("--method"),
  );
}

test("a PR no thread is linked to merges from its project, at the head the person saw", async () => {
  const records = fixtures();
  records[mergePath] = [{ body: { merged: true } }];
  records[path] = [{ body: merged }];
  const app = await environment(records);
  try {
    expect(await app.command("merge")).toMatchObject({
      ok: true,
      pr: ref,
      prStatus: { state: "merged" },
    });
    expect(await merges(app.gh)).toEqual([
      expect.objectContaining({ body: { sha, merge_method: "squash" } }),
    ]);
  } finally {
    await app.close();
  }
});

test("a merge GitHub refuses says why and leaves the next attempt free to send", async () => {
  const records = fixtures();
  records[mergePath] = [{ status: 409 }, { body: { merged: true } }];
  records[path] = [{ body: merged }];
  const app = await environment(records);
  try {
    expect(await app.command("refused")).toMatchObject({ ok: false, error: "forge_conflict" });
    expect(await app.command("again")).toMatchObject({ ok: true, prStatus: { state: "merged" } });
    expect(await merges(app.gh)).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("a merge whose answer was lost is checked on GitHub after a restart, never sent again", async () => {
  const records = fixtures();
  records[mergePath] = [{ raw: "lost acknowledgement" }];
  records[path] = [{ body: merged }];
  const app = await environment(records);
  try {
    expect(await app.command("lost")).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    await app.restart();
    // A new command, even with another method, observes the first merge instead of sending one.
    expect(await app.command("retry", app.merge("rebase"))).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
      prStatus: { state: "merged" },
    });
    expect(await merges(app.gh)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("a thread's merge waits on the page's unconfirmed merge of the same PR", async () => {
  const records = fixtures();
  records[mergePath] = [{ raw: "lost acknowledgement" }];
  records[path] = [{ body: hosted }];
  const app = await environment(records, "linked-thread");
  try {
    expect(await app.command("page")).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    expect(
      await app.command("thread", {
        type: "forge.pr.merge",
        link: { threadId: "linked-thread", pr: ref },
        headSha: sha,
        method: "squash",
      }),
    ).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    expect(await merges(app.gh)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("a squash from the PR page writes the commit title and message the person edited", async () => {
  const records = fixtures();
  records[mergePath] = [{ body: { merged: true } }];
  records[path] = [{ body: merged }];
  const app = await environment(records);
  try {
    expect(
      await app.command("edited", {
        ...app.merge("squash"),
        commit: { title: "Fix the build (#7)", message: "* Fix build\n\nCo-authored-by: A <a@x>" },
      }),
    ).toMatchObject({ ok: true, prStatus: { state: "merged" } });
    expect(await merges(app.gh)).toEqual([
      expect.objectContaining({
        body: {
          sha,
          merge_method: "squash",
          commit_title: "Fix the build (#7)",
          commit_message: "* Fix build\n\nCo-authored-by: A <a@x>",
        },
      }),
    ]);
  } finally {
    await app.close();
  }
});

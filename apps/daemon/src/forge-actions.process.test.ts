import { createCommandRunner, type CommandRunner, type CommandRequest } from "@ace/forge";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Thread, type CommandPayload } from "@ace/protocol";
import {
  fakeGh,
  standard,
  pr,
  repository,
  sha,
  nextSha,
  threads,
  type Fixtures,
} from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const path = "repos/octo/ace/pulls/7";
const mergePath = `${path}/merge`;
const link = { threadId: "action-thread", pr: { repository, number: 7 } };
const merge = { type: "forge.pr.merge", link, headSha: sha, method: "squash" } as const;
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
async function environment(
  records: Fixtures,
  transform?: (request: CommandRequest, run: CommandRunner) => ReturnType<CommandRunner>,
) {
  const gh = await fakeGh(records);
  const root = await mkdtemp(join(tmpdir(), "ace-forge-actions-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const database = join(root, "events.sqlite");
  let store = new Store(database);
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: link.threadId,
    workspaceId,
    title: "Action",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const create = () =>
    new WorkspaceRuntime(store, root, () => 1000, {
      forgeRunner: () => (request) =>
        transform
          ? transform(request, (next) => gh.runner({ ...next, command: gh.executable }))
          : gh.runner({ ...request, command: gh.executable }),
    });
  let runtime = create();
  return {
    gh,
    command(id: string, payload: CommandPayload = merge) {
      return runtime.execute(Command.parse({ id, deviceId: "device", payload }));
    },
    detail() {
      return runtime.read({
        type: "workspace.request",
        requestId: "detail",
        operation: {
          op: "forge.pr.detail",
          workspaceId,
          number: 7,
          repository,
        },
      });
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
async function writes(gh: Awaited<ReturnType<typeof fakeGh>>) {
  return (await gh.requests()).filter(
    (request) =>
      request.path !== "graphql" &&
      request.args.includes("--method") &&
      !request.args.includes("GET"),
  );
}

test("an accepted merge keeps its successful receipt when status fails and new IDs reconcile after restart", async () => {
  const records = fixtures();
  records[mergePath] = [{ body: { merged: true } }];
  records[path] = [{ status: 503 }, { status: 503 }, { body: merged }];
  const app = await environment(records);
  try {
    const accepted = await app.command("merge");
    expect(accepted).toMatchObject({ ok: true, pr: link.pr, code: "forge_status_unavailable" });
    await app.restart();
    expect(await app.command("merge")).toEqual(accepted);
    expect(await app.command("different-id")).toMatchObject({ ok: false });
    expect(await app.command("reconcile", { ...merge, method: "rebase" })).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
      prStatus: { state: "merged" },
    });
    expect(await writes(app.gh)).toEqual([
      expect.objectContaining({
        path: mergePath,
        body: { sha, merge_method: "squash" },
      }),
    ]);
  } finally {
    await app.close();
  }
});

test("an unreadable merge acknowledgement fences other actions until a read observes the merged head", async () => {
  const records = fixtures();
  records[mergePath] = [{ raw: "lost acknowledgement" }];
  records[path] = [{ body: hosted }, { body: hosted }, { body: merged }, { body: merged }];
  const app = await environment(records);
  try {
    expect(await app.command("unknown")).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    await app.restart();
    expect(await app.detail()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "prDetail",
          value: { writeState: "uncertain" },
        },
      },
    });
    expect(
      await app.command("request-instead", {
        type: "forge.review.request",
        link,
        reviewers: ["octo"],
      }),
    ).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    expect(await app.command("observe-merge")).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
      prStatus: { state: "merged" },
    });
    const detail = await app.detail();
    expect(detail).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "prDetail",
          value: { status: { state: "merged" } },
        },
      },
    });
    if (detail.result.kind !== "forge" || detail.result.data.resource !== "prDetail")
      throw new Error("Missing detail");
    expect(detail.result.data.value.writeState).toBeUndefined();
    expect(await writes(app.gh)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("a known GitHub refusal permits a fresh write without an uncertainty fence", async () => {
  const records = fixtures();
  records[mergePath] = [{ status: 409 }, { body: { merged: true } }];
  records[path] = [{ body: merged }];
  const app = await environment(records);
  try {
    expect(await app.command("refused")).toMatchObject({ ok: false, error: "forge_conflict" });
    expect(await app.command("new-intent")).toMatchObject({
      ok: true,
      prStatus: { state: "merged" },
    });
    expect(await writes(app.gh)).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("an uncertain reply cannot be retried with another body or reconciled by another author's matching reply", async () => {
  const records = fixtures();
  const replyPath = `${path}/comments/13/replies`;
  records.user = [{ body: { login: "octo" } }];
  records[replyPath] = [{ status: 503 }];
  const reply = {
    id: 30,
    body: "Fixed",
    in_reply_to_id: 13,
    user: { login: "other" },
    path: "src/main.ts",
    line: 12,
    updated_at: "2026-10-11",
  };
  records[`${path}/comments?per_page=100`] = [
    { body: [reply] },
    { body: [{ ...reply, user: { login: "octo" } }] },
  ];
  const app = await environment(records);
  const action = { type: "forge.comment.reply", link, commentId: 13, body: "Fixed" } as const;
  try {
    expect(await app.command("reply", action)).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    await app.restart();
    expect(await app.command("edited-retry", { ...action, body: "Fixed again" })).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    expect(await app.command("reconcile", action)).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
    });
    expect(await writes(app.gh)).toEqual([
      expect.objectContaining({ path: replyPath, body: { body: "Fixed" } }),
    ]);
  } finally {
    await app.close();
  }
});

test("uncertain review requests and auto-merge intents are resolved by their hosted state without another write", async () => {
  const actions: CommandPayload[] = [
    { type: "forge.review.request", link, reviewers: ["octo"] },
    { type: "forge.pr.auto-merge", link, headSha: sha, method: "squash" },
  ];
  for (const action of actions) {
    const records = fixtures();
    const request =
      action.type === "forge.review.request" ? `${path}/requested_reviewers` : "auto-merge";
    records[request] = [{ status: 503, code: 1 }];
    records[path] = [
      { body: hosted },
      {
        body: {
          ...hosted,
          requested_reviewers: [{ login: "octo" }],
          auto_merge: { merge_method: "squash" },
        },
      },
    ];
    const app = await environment(records);
    try {
      expect(await app.command("unknown", action)).toMatchObject({
        ok: false,
        error: "forge_write_uncertain",
      });
      expect(await app.command("retry", action)).toMatchObject({
        ok: false,
        error: "forge_write_uncertain",
      });
      expect(await app.command("reconcile", action)).toMatchObject({
        ok: true,
        code: "forge_action_reconciled",
      });
      expect((await app.gh.requests()).filter((entry) => entry.path === request)).toHaveLength(1);
    } finally {
      await app.close();
    }
  }
});

test("a merge that cannot launch gh settles as failed and permits a new command after restart", async () => {
  const records = fixtures();
  records[mergePath] = [{ body: { merged: true } }];
  records[path] = [{ body: merged }];
  let missing = true;
  const app = await environment(records, (request, run) =>
    missing && request.args[1] === mergePath
      ? createCommandRunner({ cwd: "/" })({ ...request, command: "/ace-missing-gh" })
      : run(request),
  );
  try {
    expect(await app.command("not-dispatched")).toMatchObject({ ok: false, error: "forge_cli" });
    await app.restart();
    missing = false;
    expect(await app.command("new-intent")).toMatchObject({
      ok: true,
      prStatus: { state: "merged" },
    });
    expect(await app.command("not-dispatched")).toMatchObject({ ok: false, error: "forge_cli" });
  } finally {
    await app.close();
  }
});

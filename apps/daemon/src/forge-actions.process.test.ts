import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
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
async function environment(
  records: Fixtures,
  options: { timeoutMs?: number; maxBytes?: number } = {},
) {
  const gh = await fakeGh(records, options);
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
  store.atomic((db) => new ForgeStore(db).link(link));
  const create = () =>
    new WorkspaceRuntime(store, root, () => 1000, {
      forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
    });
  let runtime = create();
  return {
    gh,
    command(id: string, payload: CommandPayload = merge, allowed: () => boolean = () => true) {
      return runtime.execute(Command.parse({ id, deviceId: "device", payload }), allowed);
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
      ((request.path !== "graphql" && request.path !== "merge-state-read") ||
        z
          .object({ query: z.string() })
          .safeParse(request.body)
          .data?.query.trimStart()
          .startsWith("mutation")) &&
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
    { body: [reply] },
    { body: [{ ...reply, id: 31, user: { login: "octo" } }] },
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

test("uncertain review requests are resolved by their hosted state without another write", async () => {
  const actions: CommandPayload[] = [{ type: "forge.review.request", link, reviewers: ["octo"] }];
  for (const action of actions) {
    const records = fixtures();
    const request =
      action.type === "forge.review.request" ? `${path}/requested_reviewers` : "graphql";
    records[request] = [
      { status: 503, code: 1 },
      ...(request === "graphql" ? (records.graphql ?? []) : []),
    ];
    records[path] = [
      ...(action.type === "forge.pr.auto-merge" ? [{ body: hosted }] : []),
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
      expect(await writes(app.gh)).toHaveLength(1);
    } finally {
      await app.close();
    }
  }
});

test("lost reviewer acknowledgements reconcile canonical aliases after restart and release later actions", async () => {
  const records = fixtures();
  const reviewPath = `${path}/requested_reviewers`;
  records[reviewPath] = [{ raw: "lost acknowledgement", code: 1 }];
  records[mergePath] = [{ body: { merged: true } }];
  records[path] = [
    { body: { ...hosted, requested_reviewers: [{ login: "alice" }, { login: "carol" }] } },
    {
      body: {
        ...hosted,
        requested_reviewers: [{ login: "carol" }, { login: "bob" }, { login: "alice" }],
      },
    },
    { body: merged },
  ];
  const app = await environment(records);
  try {
    expect(
      await app.command("review-aliases", {
        type: "forge.review.request",
        link,
        reviewers: ["ALICE", "Bob", "alice"],
      }),
    ).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    await app.restart();
    // An unrelated reviewer cannot stand in for a still-missing requested identity.
    expect(await app.command("missing-bob")).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    expect(await app.command("canonical-reviewers")).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
    });
    expect(await app.command("merge-after-review")).toMatchObject({
      ok: true,
      prStatus: { state: "merged" },
    });
    expect(await writes(app.gh)).toEqual([
      expect.objectContaining({ path: reviewPath, body: { reviewers: ["ALICE", "Bob", "alice"] } }),
      expect.objectContaining({ path: mergePath, body: { sha, merge_method: "squash" } }),
    ]);
  } finally {
    await app.close();
  }
});

for (const [type, message, error] of [
  ["FORBIDDEN", "No permission to enable auto-merge", "forge_forbidden"],
  ["RATE_LIMITED", "Rate limit exceeded", "forge_rate_limit"],
  ["UNPROCESSABLE", "Auto-merge is disabled for this repository", "forge_conflict"],
  ["UNPROCESSABLE", "Required checks are not configured", "forge_conflict"],
]) {
  test(`a definite auto-merge refusal (${message}) releases later actions after restart`, async () => {
    const records = fixtures();
    records["merge-state-write"] = [
      {
        code: 1,
        body: { data: { enablePullRequestAutoMerge: null }, errors: [{ type, message }] },
      },
    ];
    records[path] = [{ body: merged }];
    records[mergePath] = [{ body: { merged: true } }];
    const app = await environment(records);
    try {
      expect(
        await app.command("refused-auto-merge", { ...merge, type: "forge.pr.auto-merge" }),
      ).toMatchObject({
        ok: false,
        error,
      });
      await app.restart();
      expect(await app.command("merge-after-refusal")).toMatchObject({
        ok: true,
        prStatus: { state: "merged" },
      });
      expect(await writes(app.gh)).toEqual([
        expect.objectContaining({
          path: "merge-state-write",
          body: expect.objectContaining({
            variables: {
              input: { pullRequestId: "PR_7", expectedHeadOid: sha, mergeMethod: "SQUASH" },
            },
          }),
        }),
        expect.objectContaining({ path: mergePath }),
      ]);
    } finally {
      await app.close();
    }
  });
}

for (const failure of ["timeout", "output limit"] as const) {
  test(`auto-merge ${failure} after spawn remains fenced across restart`, async () => {
    const records = fixtures();
    records["merge-state-write"] = [
      failure === "timeout" ? { wait: true } : { repeat: 16, text: "x".repeat(1024) },
    ];
    const app = await environment(
      records,
      failure === "timeout" ? { timeoutMs: 5000 } : { maxBytes: 1024 },
    );
    try {
      expect(
        await app.command("uncertain-auto-merge", { ...merge, type: "forge.pr.auto-merge" }),
      ).toMatchObject({ ok: false, error: "forge_write_uncertain" });
      await app.restart();
      expect(await app.command("merge-still-fenced")).toMatchObject({
        ok: false,
        error: "forge_write_uncertain",
      });
      expect(await writes(app.gh)).toEqual([
        expect.objectContaining({
          path: "merge-state-write",
          body: expect.objectContaining({
            variables: {
              input: { pullRequestId: "PR_7", expectedHeadOid: sha, mergeMethod: "SQUASH" },
            },
          }),
        }),
      ]);
    } finally {
      await app.close();
    }
  });
}

for (const action of [merge, { ...merge, type: "forge.pr.auto-merge" } as const]) {
  test(`a missing gh executable does not strand ${action.type} behind a permanent fence`, async () => {
    const records = fixtures();
    records[mergePath] = [{ body: { merged: true } }];
    if (action.type === "forge.pr.auto-merge") {
      const source = {
        id: "PR_7",
        number: 7,
        headRefOid: sha,
        state: "OPEN",
        isDraft: false,
        mergeStateStatus: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: { state: "SUCCESS" },
        mergeQueueEntry: null,
        viewerCanEnableAutoMerge: true,
        viewerCanDisableAutoMerge: true,
      };
      records["merge-state-read"] = [
        null,
        { mergeMethod: "SQUASH", enabledAt: "2026-10-11", enabledBy: { login: "octo" } },
      ].map((autoMergeRequest) => ({
        body: {
          data: {
            repository: { viewerPermission: "WRITE", pullRequest: { ...source, autoMergeRequest } },
          },
        },
      }));
      records["merge-state-write"] = [
        { body: { data: { enablePullRequestAutoMerge: { clientMutationId: null } } } },
      ];
    }
    records[path] = [{ body: hosted }, { body: merged }];
    const app = await environment(records);
    const backup = `${app.gh.executable}.saved`;
    try {
      await rename(app.gh.executable, backup);
      expect(await app.command("not-installed", action)).toMatchObject({
        ok: false,
        error: "forge_cli",
      });
      await rename(backup, app.gh.executable);
      const detail = await app.detail();
      if (detail.result.kind !== "forge" || detail.result.data.resource !== "prDetail")
        throw new Error("Missing detail");
      expect(detail.result.data.value.writeState).toBeUndefined();
      expect(await app.command("installed-now", action)).toMatchObject({ ok: true });
    } finally {
      await app.close();
    }
  });
}

test("an empty reply fails locally without fencing a later valid reply", async () => {
  const records = fixtures();
  records.user = [{ body: { login: "octo" } }];
  records[`${path}/comments/13/replies`] = [{ body: { id: 31 } }];
  const app = await environment(records);
  const action = { type: "forge.comment.reply", link, commentId: 13, body: "" } as const;
  try {
    expect(await app.command("empty", action)).toMatchObject({ ok: false });
    expect(await app.command("valid", { ...action, body: "Fixed" })).toMatchObject({ ok: true });
    expect(await writes(app.gh)).toEqual([expect.objectContaining({ body: { body: "Fixed" } })]);
  } finally {
    await app.close();
  }
});

test("a pre-merge detail read cannot retire an accepted merge fence after its status read fails", async () => {
  const records = fixtures();
  records[path] = [{ body: hosted }, { status: 503 }, { body: merged }];
  records[mergePath] = [{ body: { merged: true } }];
  const first = records.graphql?.[0];
  records.graphql = [{ ...first, barrier: "old-read" }, first ?? {}];
  const app = await environment(records);
  try {
    const oldRead = app.detail().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await app.gh.waitForRequest("graphql");
    expect(await app.command("merge-spanning-read")).toMatchObject({
      ok: true,
      code: "forge_status_unavailable",
    });
    await app.gh.release("old-read");
    expect(await oldRead).toMatchObject({ error: { kind: "conflict" } });
    expect(await app.command("reconcile-only")).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
      prStatus: { state: "merged" },
    });
    expect(await writes(app.gh)).toEqual([expect.objectContaining({ path: mergePath })]);
  } finally {
    await app.close();
  }
});

test("a pre-existing identical reply cannot reconcile a later reply whose acknowledgement was lost", async () => {
  const records = fixtures();
  records.user = [{ body: { login: "octo" } }];
  records[`${path}/comments/13/replies`] = [{ raw: "lost acknowledgement" }];
  const old = {
    id: 30,
    body: "Fixed",
    in_reply_to_id: 13,
    user: { login: "octo" },
    path: "src/main.ts",
    line: 12,
    updated_at: "2026-10-11",
  };
  records[`${path}/comments?per_page=100`] = [
    { body: [old] },
    { body: [old] },
    { body: [old, { ...old, id: 31 }] },
  ];
  const app = await environment(records);
  const action = { type: "forge.comment.reply", link, commentId: 13, body: "Fixed" } as const;
  try {
    expect(await app.command("reply-again", action)).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    await app.restart();
    expect(await app.command("old-match", action)).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    expect(await app.command("new-match", action)).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
    });
    expect(await writes(app.gh)).toEqual([expect.objectContaining({ body: { body: "Fixed" } })]);
  } finally {
    await app.close();
  }
});

test("revoking permission during auto-merge metadata reads prevents mutation dispatch", async () => {
  const records = fixtures();
  records["merge-state-read"] = [{ ...mergeStateResponse(), barrier: "auto-preflight" }];
  records[path] = [{ body: merged }];
  records[mergePath] = [{ body: { merged: true } }];
  const app = await environment(records);
  let allowed = true;
  try {
    const action = app.command(
      "revoked-auto-merge",
      { ...merge, type: "forge.pr.auto-merge" },
      () => allowed,
    );
    await app.gh.waitForRequest("merge-state-read");
    allowed = false;
    await app.gh.release("auto-preflight");
    expect(await action).toMatchObject({ ok: false, error: "forge_forbidden" });
    expect(await writes(app.gh)).toEqual([]);
    await app.restart();
    expect(await app.command("authorized-merge")).toMatchObject({
      ok: true,
      prStatus: { state: "merged" },
    });
  } finally {
    await app.close();
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Command, Thread, WorkspaceActionRequest } from "@ace/protocol";
import type { CommandRequest } from "@ace/forge";
import { fakeGh, standard, repository, sha, threads, type Response } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);
const armed = { mergeMethod: "SQUASH", enabledAt: "2026-10-11", enabledBy: { login: "octo" } };
function state(autoMergeRequest: unknown = null): Response {
  return {
    body: {
      data: {
        repository: {
          viewerPermission: "WRITE",
          pullRequest: {
            id: "PR_7",
            number: 7,
            headRefOid: sha,
            state: "OPEN",
            isDraft: false,
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            statusCheckRollup: { state: "SUCCESS" },
            autoMergeRequest,
            mergeQueueEntry: null,
            viewerCanEnableAutoMerge: true,
            viewerCanDisableAutoMerge: true,
          },
        },
      },
    },
  };
}
function refusal(type: string): Response {
  return { code: 1, body: { errors: [{ type, message: "GitHub refused this request" }] } };
}
const accepted: Response = {
  body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } },
};
async function fixture(
  reads: Response[],
  writes: Response[],
  commandFor: (request: CommandRequest, executable: string) => string = (_request, executable) =>
    executable,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-merge-certainty-"));
  const gh = await fakeGh({
    ...standard(),
    graphql: [{ body: threads() }],
    "merge-state-read": reads,
    "merge-state-write": writes,
  });
  const db = join(root, "events.sqlite");
  await execute("git", ["init", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  let store = new Store(db);
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "merge-certainty",
    workspaceId,
    provider: "codex",
    title: "Merge state",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const options = {
    forgeRunner: () => (request: CommandRequest) =>
      gh.runner({ ...request, command: commandFor(request, gh.executable) }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  await runtime.forge.link(thread.id, root, { repository, number: 7 });
  return {
    gh,
    command(id: string) {
      return runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: {
            type: "forge.pr.merge-state.change",
            link: { threadId: thread.id, pr: { repository, number: 7 } },
            action: "enable",
            headSha: sha,
            method: "squash",
          },
        }),
      );
    },
    read() {
      return runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "read",
          operation: {
            op: "forge.pr.merge-state",
            workspaceId,
            repository,
            number: 7,
          },
        }),
      );
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(db);
      runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    },
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each([
  ["malformed", true],
  ["missing PR", { clientMutationId: null }],
  ["mismatched PR", { pullRequest: { id: "PR_8" } }],
])(
  "a %s acknowledgement keeps the durable outcome uncertain and fences retry after restart",
  async (_description, acknowledgement) => {
    const f = await fixture(
      [state()],
      [{ body: { data: { enablePullRequestAutoMerge: acknowledgement } } }],
    );
    try {
      expect(await f.command("unconfirmed")).toMatchObject({
        ok: false,
        error: "forge_write_uncertain",
      });
      expect(await f.read()).toMatchObject({
        result: {
          kind: "forge",
          data: { value: { autoMerge: null, writeState: "uncertain" } },
        },
      });
      await f.restart();
      expect(await f.command("reviewed-retry")).toMatchObject({
        ok: false,
        error: "forge_write_uncertain",
      });
      expect(await f.read()).toMatchObject({
        result: {
          kind: "forge",
          data: { value: { autoMerge: null, writeState: "uncertain" } },
        },
      });
      const writes = (await f.gh.requests()).filter((r) => r.path === "merge-state-write");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toMatchObject({
        query: expect.stringContaining("pullRequest{id}"),
        variables: { input: { pullRequestId: "PR_7" } },
      });
    } finally {
      await f.close();
    }
  },
);

test.each(["FORBIDDEN", "RATE_LIMITED", "NOT_FOUND"])(
  "a %s reconciliation read cannot release an ambiguously accepted mutation after restart",
  async (type) => {
    const f = await fixture(
      [state(), refusal(type), state()],
      [{ raw: "lost acknowledgement", code: 1 }],
    );
    try {
      expect(await f.command("lost")).toMatchObject({ ok: false, error: "forge_write_uncertain" });
      await f.restart();
      expect(await f.command("another-intent")).toMatchObject({
        ok: false,
        error: "forge_write_uncertain",
      });
      expect((await f.gh.requests()).filter((r) => r.path === "merge-state-write")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test.each([
  ["FORBIDDEN", "forge_forbidden"],
  ["RATE_LIMITED", "forge_rate_limit"],
  ["NOT_FOUND", "forge_not_found"],
  ["UNPROCESSABLE", "forge_conflict"],
] as const)(
  "a complete %s refusal permits retry even when a later read is unreadable",
  async (type, error) => {
    const f = await fixture(
      [state(), { raw: "unreadable state" }, state(), state(armed)],
      [refusal(type), accepted],
    );
    try {
      expect(await f.command("refused")).toMatchObject({ ok: false, error });
      expect(await f.read()).toMatchObject({
        result: { kind: "error", code: "forge_invalid_data" },
      });
      await f.restart();
      expect(await f.command("reviewed-retry")).toMatchObject({
        ok: true,
        prStatus: { mergeState: { autoMerge: { method: "SQUASH" } } },
      });
      expect((await f.gh.requests()).filter((r) => r.path === "merge-state-write")).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
);

test.each(["FORBIDDEN", "RATE_LIMITED", "NOT_FOUND"])(
  "an accepted mutation remains accepted when its follow-up read returns %s",
  async (type) => {
    const f = await fixture([state(), refusal(type), state()], [accepted]);
    try {
      expect(await f.command("accepted")).toMatchObject({
        ok: true,
        code: "forge_status_unavailable",
      });
      await f.restart();
      expect(await f.command("reconcile-only")).toMatchObject({
        ok: true,
        code: "forge_action_reconciled",
      });
      expect((await f.gh.requests()).filter((r) => r.path === "merge-state-write")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test("partial mutation data with a forbidden error stays uncertain and cannot repeat the write", async () => {
  const f = await fixture(
    [state()],
    [
      {
        code: 1,
        body: {
          data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } },
          errors: [{ type: "FORBIDDEN", message: "Another field could not be read" }],
        },
      },
    ],
  );
  try {
    expect(await f.command("partial")).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    await f.restart();
    expect(await f.command("new-intent")).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    expect((await f.gh.requests()).filter((r) => r.path === "merge-state-write")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each(["missing", "not-executable"])(
  "a %s gh at mutation dispatch permits a restored CLI to retry",
  async (fault) => {
    let fail = true;
    const f = await fixture(
      [state(), state(), state(), state(armed)],
      [accepted],
      (request, executable) => {
        if (fail && request.input?.includes("mutation(")) {
          fail = false;
          return join(executable, "..", fault === "missing" ? "missing-gh" : "denied-gh");
        }
        return executable;
      },
    );
    try {
      await writeFile(join(f.gh.dir, "denied-gh"), "#!/usr/bin/env node\n", { mode: 0o600 });
      expect(await f.command("unsent")).toMatchObject({ ok: false, error: "forge_cli" });
      const snapshot = await f.read();
      if (snapshot.result.kind !== "forge" || snapshot.result.data.resource !== "prMergeState")
        throw new Error("Expected merge state");
      expect(snapshot.result.data.value.writeState).toBeUndefined();
      await f.restart();
      expect(await f.command("restored")).toMatchObject({
        ok: true,
        prStatus: { mergeState: { autoMerge: { method: "SQUASH" } } },
      });
      expect((await f.gh.requests()).filter((r) => r.path === "merge-state-write")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

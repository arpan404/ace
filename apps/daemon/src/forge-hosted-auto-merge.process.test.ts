import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { Command, type CommandPayload } from "@ace/protocol";
import {
  fakeGh,
  standard,
  repository,
  sha,
  threads,
  check,
  type Fixtures,
} from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const ref = { repository, number: 7 };
const pr = {
  id: "PR_7",
  number: 7,
  headRefOid: sha,
  state: "OPEN",
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: { state: "PENDING" },
  autoMergeRequest: null,
  mergeQueueEntry: null,
  viewerCanEnableAutoMerge: true,
  viewerCanDisableAutoMerge: false,
};
const armed = { mergeMethod: "SQUASH", enabledAt: "2026-10-11", enabledBy: { login: "octo" } };
const state = (patch: Record<string, unknown> = {}) => ({
  body: {
    data: { repository: { viewerPermission: "WRITE", pullRequest: { ...pr, ...patch } } },
  },
});
const enabled = { body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } } };

/** A project whose PR #7 no thread is linked to; GitHub answers GraphQL reads in order. */
async function environment(graphql: Fixtures[string]) {
  const fixtures = standard();
  fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [{ ...check, conclusion: null, status: "in_progress" }] } },
  ];
  fixtures.graphql = graphql;
  const gh = await fakeGh(fixtures);
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-auto-merge-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const database = join(root, "events.sqlite");
  let store = new Store(database);
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: Parameters<typeof gh.runner>[0]) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  const enable: CommandPayload = {
    type: "forge.hosted.merge-state",
    workspaceId,
    pr: ref,
    headSha: sha,
    action: "enable",
    method: "squash",
  };
  return {
    gh,
    command(id: string, payload: CommandPayload = enable) {
      return runtime.execute(Command.parse({ id, deviceId: "device", payload }), () => true);
    },
    async mutations() {
      return (await gh.requests()).filter(
        (request) =>
          request.path === "graphql" &&
          z
            .object({ query: z.string() })
            .safeParse(request.body)
            .data?.query.trimStart()
            .startsWith("mutation"),
      );
    },
    async restart() {
      await runtime.close();
      await store.close();
      store = new Store(database);
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

test("auto-merge turns on for a PR no thread is linked to, pinned to the head the person saw", async () => {
  const app = await environment([
    state(),
    enabled,
    { body: threads() },
    state({ autoMergeRequest: armed }),
    state({ autoMergeRequest: armed }),
  ]);
  try {
    expect(await app.command("enable")).toMatchObject({
      ok: true,
      prStatus: { mergeState: { autoMerge: { method: "SQUASH", actor: "octo" } } },
    });
    const sent = await app.mutations();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      variables: { input: { pullRequestId: "PR_7", expectedHeadOid: sha, mergeMethod: "SQUASH" } },
    });
  } finally {
    await app.close();
  }
});

test("an auto-merge whose answer was lost is checked on GitHub after a restart, never sent again", async () => {
  const app = await environment([
    state(),
    { raw: "lost acknowledgement", code: 1 },
    state(),
    { body: threads() },
    state({ autoMergeRequest: armed }),
    state({ autoMergeRequest: armed }),
  ]);
  try {
    expect(await app.command("lost")).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    await app.restart();
    expect(await app.command("retry")).toMatchObject({
      ok: true,
      code: "forge_action_reconciled",
    });
    expect(await app.mutations()).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("a repository that doesn't allow auto-merge refuses it before anything is sent", async () => {
  const app = await environment([state({ viewerCanEnableAutoMerge: false })]);
  try {
    expect(await app.command("refused")).toMatchObject({ ok: false, error: "forge_forbidden" });
    expect(await app.mutations()).toHaveLength(0);
  } finally {
    await app.close();
  }
});

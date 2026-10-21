import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  fakeGh,
  mergeStateResponse,
  nextSha,
  pr,
  repository,
  sha,
  standard,
  threads,
  type Fixtures,
} from "@ace/forge/testing";
import { Store } from "../store.ts";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { workspaceVerifyForge } from "./forge-port.ts";

const execute = promisify(execFile);
const path = "repos/octo/ace/pulls/7";
const mergePath = `${path}/merge`;
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

function fixtures(merge: Fixtures[string]): Fixtures {
  const value = standard();
  value[path] = [{ body: { ...hosted, state: "closed", merged: true, merged_at: "2026-10-11" } }];
  value[mergePath] = merge;
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

/** Verify's GitHub port over the daemon's real workspace forge, with `gh` scripted. */
async function port(merge: Fixtures[string]) {
  const gh = await fakeGh(fixtures(merge));
  const root = await mkdtemp(join(tmpdir(), "ace-verify-forge-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  const forge = workspaceVerifyForge(runtime);
  return {
    merge: (runId: string, method: "merge" | "squash" | "rebase" = "squash") =>
      forge.merge({
        project: root,
        workspaceId,
        runId,
        pr: { repository, number: 7 },
        headSha: sha,
        method,
        allowed: () => true,
      }),
    async sent() {
      return (await gh.requests()).filter(
        (request) => request.path === mergePath && request.args.includes("--method"),
      );
    },
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a batch's merge goes through the hosted merge path, pinned to the tested head", async () => {
  const app = await port([{ body: { merged: true } }]);
  try {
    expect(await app.merge("run-1", "rebase")).toEqual({ outcome: "merged" });
    expect(await app.sent()).toEqual([
      expect.objectContaining({ body: { sha, merge_method: "rebase" } }),
    ]);
  } finally {
    await app.close();
  }
});

test("GitHub refusing a batch's merge reads as refused, with words a person can act on", async () => {
  const app = await port([{ status: 409 }]);
  try {
    const answer = await app.merge("run-1");
    expect(answer).toMatchObject({ outcome: "refused" });
    expect(answer.outcome === "refused" && answer.message.length > 0).toBe(true);
  } finally {
    await app.close();
  }
});

test("a lost answer to a batch's merge reads as uncertain, and a later run settles it from GitHub without sending it again", async () => {
  const app = await port([{ raw: "lost acknowledgement" }]);
  try {
    expect(await app.merge("run-1")).toEqual({ outcome: "uncertain" });
    // The PR's merge journal reads GitHub (which shows it merged) instead of merging again.
    expect(await app.merge("run-2")).toEqual({ outcome: "merged" });
    expect(await app.sent()).toHaveLength(1);
  } finally {
    await app.close();
  }
});

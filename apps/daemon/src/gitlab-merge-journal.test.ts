import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ForgeHostedMergeCommand, ForgeRepository, WorkspaceId } from "@ace/protocol";
import { GitLabHostedMerge, type CommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { ForgeResourceOwner } from "./forge-resource-owner.ts";
import { WorkspaceForgeActions } from "./workspace-forge-actions.ts";

// A real SQLite journal survives restart even when the remote accepted a lost merge reply.
test("an uncertain GitLab merge reconciles after restart without dispatching it twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-glab-merge-journal-"));
  const database = join(root, "events.sqlite");
  let store = new Store(database);
  const repository = ForgeRepository.parse({
    forge: "gitlab",
    host: "gitlab.com",
    owner: "team",
    name: "repo",
  });
  const sha = "a".repeat(40);
  let merged = false;
  let writes = 0;
  const runner: CommandRunner = async (request) => {
    const endpoint = request.args[1] ?? "";
    const method = request.args[3];
    let body: unknown;
    if (method === "PUT") {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      expect(JSON.parse(request.input ?? "null")).toMatchObject({ sha });
      writes++;
      merged = true;
      throw new Error("Reply lost after merge");
    }
    if (endpoint.endsWith("/merge_requests/7"))
      body = {
        iid: 7,
        title: "Change",
        state: merged ? "merged" : "opened",
        sha,
        updated_at: "2026-11-01T00:00:00Z",
        draft: false,
        has_conflicts: false,
        detailed_merge_status: "mergeable",
        blocking_discussions_resolved: true,
        merge_when_pipeline_succeeds: false,
        squash: false,
        user: { can_merge: true },
        head_pipeline: { id: 10, status: "success", sha },
      };
    else if (endpoint.includes("/pipelines/10/jobs"))
      body = [
        { id: 11, name: "test", status: "success", pipeline: { id: 10, status: "success", sha } },
      ];
    else if (endpoint.includes("/merge_requests/7/pipelines"))
      body = [{ id: 10, status: "success", sha }];
    else if (endpoint.endsWith("/pipelines/10")) body = { id: 10, status: "success", sha };
    else if (endpoint.includes("/discussions?")) body = [];
    else if (endpoint.endsWith("/approvals")) body = { approved: false, approved_by: [] };
    else if (endpoint.endsWith("/approval_state")) body = { rules: [] };
    else body = { squash_option: "default_off" };
    return {
      code: 0,
      truncated: false,
      stdout: `HTTP/2.0 200 OK\nx-next-page: \n\n${JSON.stringify(body)}`,
    };
  };
  const backend = new GitLabHostedMerge({ repository, runner });
  const action = ForgeHostedMergeCommand.parse({
    type: "forge.hosted.merge",
    workspaceId: WorkspaceId.parse("workspace"),
    pr: { repository, number: 7 },
    headSha: sha,
    method: "merge",
  });
  const signal = new AbortController().signal;
  try {
    let actions = new WorkspaceForgeActions(store, new ForgeResourceOwner(), () => 1);
    expect(
      await actions.execute(
        action,
        backend,
        signal,
        () => true,
        () => {},
      ),
    ).toMatchObject({ ok: false, error: "forge_write_uncertain" });
    await store.close();
    store = new Store(database);
    actions = new WorkspaceForgeActions(store, new ForgeResourceOwner(), () => 2);
    expect(
      await actions.execute(
        action,
        backend,
        signal,
        () => true,
        () => {},
      ),
    ).toMatchObject({ ok: true, code: "forge_action_reconciled", prStatus: { state: "merged" } });
    expect(writes).toBe(1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

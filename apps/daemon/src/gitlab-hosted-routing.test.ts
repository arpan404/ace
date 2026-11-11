import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { Command, ForgeRepository, type ForgeBrowserOperation } from "@ace/protocol";
import type { CommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { SourceControl } from "./source-control.ts";
import { ProjectRepositoryConfigs } from "./project-repository-config.ts";
import { WorkspaceForge } from "./workspace-forge.ts";

test("GitLab hosted reads route checks and merge state through glab and tag to-dos to the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-glab-routing-"));
  const settings = new SettingsService({ dataDir: root });
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Repo");
  const repository = ForgeRepository.parse({
    forge: "gitlab",
    host: "gitlab.com",
    owner: "team",
    name: "repo",
  });
  const sha = "a".repeat(40);
  const todo = {
    id: 8,
    project: { id: 1, path_with_namespace: "team/repo" },
    action_name: "mentioned",
    target_type: "MergeRequest",
    target: { iid: 7, title: "Change", state: "opened" },
    body: "mentioned",
    state: "pending",
    created_at: "2026-11-01T00:00:00Z",
  };
  const runner: CommandRunner = async (request) => {
    expect(request.command).toBe("glab");
    const path = request.args[1] ?? "";
    let body: unknown;
    if (path === "user") body = { username: "alice" };
    else if (path.includes("/jobs/11/trace"))
      return { code: 0, truncated: false, stdout: "HTTP/2.0 200 OK\n\nhello test\n" };
    else if (path.endsWith("/jobs/11"))
      body = {
        id: 11,
        name: "unit",
        status: "running",
        pipeline: { id: 10, status: "running", sha },
      };
    else if (path.includes("/pipelines/10/jobs"))
      body = [
        { id: 11, name: "unit", status: "running", pipeline: { id: 10, status: "running", sha } },
      ];
    else if (path.includes("/merge_requests/7/pipelines"))
      body = [{ id: 10, status: "running", sha }];
    else if (path.endsWith("/merge_requests/7"))
      body = {
        iid: 7,
        title: "Change",
        state: "opened",
        sha,
        draft: false,
        has_conflicts: false,
        detailed_merge_status: "ci_still_running",
        blocking_discussions_resolved: true,
        merge_when_pipeline_succeeds: false,
        squash: false,
        user: { can_merge: true },
        head_pipeline: { id: 10, status: "running", sha },
      };
    else if (path.startsWith("todos?")) body = [todo];
    else if (path === "todos/8/mark_as_done") {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      body = { ...todo, state: "done" };
    } else if (path === "todos/8") body = todo;
    else body = { squash_option: "default_off" };
    return {
      code: 0,
      truncated: false,
      stdout: `HTTP/2.0 200 OK\nx-next-page: \n\n${JSON.stringify(body)}`,
    };
  };
  const source = new SourceControl(
    settings,
    () => runner,
    root,
    () => 1,
  );
  const forge = new WorkspaceForge(
    store,
    {
      repositoryInfo: async () => ({
        root,
        branch: "topic",
        detached: false,
        head: sha,
        upstream: null,
        ahead: 0,
        behind: 0,
        remotes: [
          {
            name: "origin",
            fetchUrls: ["https://gitlab.com/team/repo.git"],
            pushUrls: ["https://gitlab.com/team/repo.git"],
          },
        ],
      }),
    },
    () => 1,
    () => runner,
    source,
  );
  const signal = new AbortController().signal;
  const read = (operation: ForgeBrowserOperation) => forge.browse(root, operation, signal);
  try {
    await settings.set(
      "sourceControl.preferences",
      {
        hosts: [{ host: "gitlab.com", forge: "gitlab", account: "alice" }],
        host: "gitlab.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    expect(
      await read({ op: "forge.pr.check", workspaceId, repository, checkRunId: 11 }),
    ).toMatchObject({
      resource: "prCheck",
      value: { id: 11, status: "pending", logUnavailable: false },
    });
    expect(
      await read({ op: "forge.pr.merge-state", workspaceId, repository, number: 7 }),
    ).toMatchObject({ resource: "prMergeState", value: { checksState: "PENDING" } });
    expect(
      await read({
        op: "forge.inbox.list",
        workspaceId,
        query: { all: false, participating: false, page: 1 },
      }),
    ).toMatchObject({
      resource: "inboxList",
      value: {
        projectRepository: repository,
        projectRepositories: [repository],
        items: [{ id: "8", repository, number: 7 }],
      },
    });
    const command = Command.parse({
      id: "done-todo",
      deviceId: "test-device",
      createdAt: 1,
      payload: { type: "forge.inbox.write", workspaceId, input: { action: "done", id: "8" } },
    });
    if (command.payload.type !== "forge.inbox.write") throw new Error("Invalid test command");
    expect(
      await forge.inboxCommand({ ...command, payload: command.payload }, root, () => true),
    ).toMatchObject({ ok: true, inboxAction: { action: "done", state: "succeeded" } });
    new ProjectRepositoryConfigs(store).set(workspaceId, {
      added: [],
      hidden: [repository],
      primary: null,
    });
    const hiddenCommand = { ...command, payload: { ...command.payload, host: "gitlab.com" } };
    expect(await forge.inboxCommand(hiddenCommand, root, () => true)).toMatchObject({
      ok: false,
      error: "repository_hidden",
    });
  } finally {
    forge.close();
    source.close();
    await settings.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

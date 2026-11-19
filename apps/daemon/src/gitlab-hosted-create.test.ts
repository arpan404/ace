import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { Command, ForgeRepository } from "@ace/protocol";
import type { CommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { SourceControl } from "./source-control.ts";
import { WorkspaceForge } from "./workspace-forge.ts";
import { ProjectRepositoryConfigs } from "./project-repository-config.ts";

test("a hosted GitLab MR opens on the primary from its pushed fork with nested namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-glab-create-route-"));
  const store = new Store(join(root, "events.sqlite"));
  const settings = new SettingsService({ dataDir: root });
  const workspaceId = store.createWorkspace(root, "Repo");
  const repository = ForgeRepository.parse({
    forge: "gitlab",
    host: "gitlab.com",
    owner: "team/sub",
    name: "repo",
  });
  const fork = { ...repository, owner: "alice/sub", name: "fork" };
  const target = { id: 1, path_with_namespace: "team/sub/repo", default_branch: "main" };
  const sourceProject = {
    id: 2,
    path_with_namespace: "alice/sub/fork",
    default_branch: "main",
    forked_from_project: target,
  };
  const sha = "a".repeat(40);
  const writes: { endpoint: string; body: unknown }[] = [];
  let created = false;
  const runner: CommandRunner = async (request) => {
    const path = request.args[1] ?? "";
    let body: unknown;
    const mr = {
      iid: 7,
      source_project_id: 2,
      target_project_id: 1,
      source_branch: "topic",
      target_branch: "main",
      state: "opened",
      title: "Change",
      sha,
      updated_at: "2026-11-01T00:00:00Z",
    };
    if (path === "user") body = { username: "alice" };
    else if (path === "projects/team%2Fsub%2Frepo") body = target;
    else if (path === "projects/alice%2Fsub%2Ffork") body = sourceProject;
    else if (path.includes("repository/branches?"))
      body = [
        { name: "main", commit: { id: sha } },
        { name: "topic", commit: { id: sha } },
      ];
    else if (path.includes("merge_requests?")) body = created ? [mr] : [];
    else if (request.input !== undefined) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push({ endpoint: path, body: JSON.parse(request.input) });
      created = true;
      body = mr;
    } else if (path.endsWith("/merge_requests/7")) body = mr;
    else if (path.includes("/merge_requests/7/pipelines")) body = [];
    else throw new Error(`Unexpected ${path}`);
    return {
      code: 0,
      truncated: false,
      stdout: `HTTP/2 200 OK\nx-next-page: \n\n${JSON.stringify(body)}`,
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
            fetchUrls: ["https://gitlab.com/alice/sub/fork.git"],
            pushUrls: ["https://gitlab.com/alice/sub/fork.git"],
          },
          {
            name: "upstream",
            fetchUrls: ["https://gitlab.com/team/sub/repo.git"],
            pushUrls: ["https://gitlab.com/team/sub/repo.git"],
          },
        ],
      }),
    },
    () => 1,
    () => runner,
    source,
  );
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
    new ProjectRepositoryConfigs(store).set(workspaceId, {
      added: [],
      hidden: [],
      primary: repository,
    });
    expect(
      await forge.browse(
        root,
        { op: "forge.pr.new-context", workspaceId },
        new AbortController().signal,
      ),
    ).toMatchObject({
      resource: "newPrContext",
      value: { base: { repository }, head: { repository: fork } },
    });
    const command = Command.parse({
      id: "create",
      deviceId: "device",
      createdAt: 1,
      payload: {
        type: "forge.hosted.pr.create",
        workspaceId,
        repository,
        head: { owner: fork.owner, name: fork.name, branch: "topic" },
        base: "main",
        title: "Change",
        body: "Description",
        labels: ["bug"],
        draft: true,
      },
    });
    if (command.payload.type !== "forge.hosted.pr.create") throw new Error("Invalid test command");
    expect(
      await forge.hostedPrCreate({ ...command, payload: command.payload }, root, () => true),
    ).toMatchObject({ ok: true, pr: { repository, number: 7 } });
    expect(writes).toEqual([
      {
        // Posted to the fork by path: the one project admission pins besides the target.
        endpoint: "projects/alice%2Fsub%2Ffork/merge_requests",
        body: {
          source_branch: "topic",
          target_branch: "main",
          target_project_id: 1,
          title: "Draft: Change",
          description: "Description",
          labels: "bug",
        },
      },
    ]);
    expect(
      await forge.hostedPrCreate({ ...command, payload: command.payload }, root, () => true),
    ).toMatchObject({ ok: true, prExisting: true });
    expect(writes).toHaveLength(1);
    // A fork the project hides is never written to, even though the target is visible.
    created = false;
    new ProjectRepositoryConfigs(store).set(workspaceId, {
      added: [],
      hidden: [fork],
      primary: repository,
    });
    const hidden = await forge
      .hostedPrCreate({ ...command, payload: command.payload }, root, () => true)
      .catch((error: unknown) => ({ ok: false, error: String(error) }));
    expect(hidden).toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
  } finally {
    forge.close();
    source.close();
    await settings.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

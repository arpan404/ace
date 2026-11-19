import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { ForgeRepository, Thread } from "@ace/protocol";
import { ForgeStore, type CommandRequest, type CommandRunner } from "@ace/forge";
import { Store } from "./store.ts";
import { SourceControl } from "./source-control.ts";
import { WorkspaceForge } from "./workspace-forge.ts";

const head = "a".repeat(40);

/** A Gitea host per its API v1 (gitea.com/swagger.v1.json), reached only through tea. */
function teaHost(writes: CommandRequest[]): CommandRunner {
  return async (request) => {
    expect(request.command).toBe("tea");
    const path = request.args[1] ?? "";
    let body: unknown;
    if (request.args[0] === "login")
      body = [{ name: "work", url: "https://git.example", user: "alice" }];
    else if (request.input !== undefined) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push(request);
      return { code: 0, stdout: "", truncated: false, http: { status: 200, headers: {} } };
    } else if (path === "user") body = { login: "alice" };
    else if (path === "repos/team/app")
      body = {
        archived: false,
        permissions: { push: true },
        allow_merge_commits: true,
        allow_squash_merge: true,
        allow_rebase: true,
      };
    else if (path.includes("/status?"))
      body = { sha: head, state: "success", total_count: 0, statuses: [] };
    else if (/\/(comments|reviews)\?/.test(path)) body = [];
    else
      body = {
        number: 7,
        title: "Feature",
        state: writes.length ? "closed" : "open",
        merged: writes.length > 0,
        mergeable: true,
        head: { sha: head, ref: "feature" },
        base: { sha: "b".repeat(40), ref: "main" },
        user: { login: "alice" },
      };
    return {
      code: 0,
      stdout: JSON.stringify(body),
      truncated: false,
      http: { status: 200, headers: {} },
    };
  };
}

for (const forge of ["gitea", "forgejo"] as const) {
  test(`a ${forge} PR linked to a thread merges from the thread through tea, and refuses replies and review requests`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-tea-thread-"));
    const settings = new SettingsService({ dataDir: root });
    const store = new Store(join(root, "events.sqlite"));
    const workspaceId = store.createWorkspace(root, "Repo");
    const repository = ForgeRepository.parse({
      forge,
      host: "git.example",
      owner: "team",
      name: "app",
    });
    const pr = { repository, number: 7 };
    const thread = Thread.parse({
      id: "thread",
      workspaceId,
      title: "Linked",
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    store.atomic((db) => new ForgeStore(db).link({ threadId: thread.id, pr }));
    const writes: CommandRequest[] = [];
    const runner = teaHost(writes);
    const source = new SourceControl(
      settings,
      () => runner,
      root,
      () => 1,
    );
    const workspace = new WorkspaceForge(
      store,
      {
        repositoryInfo: async () => ({
          root,
          branch: "feature",
          detached: false,
          head,
          upstream: null,
          ahead: 0,
          behind: 0,
          remotes: [
            {
              name: "origin",
              fetchUrls: ["https://git.example/team/app.git"],
              pushUrls: ["https://git.example/team/app.git"],
            },
          ],
        }),
      },
      () => 1,
      () => async () => {
        throw new Error("GitHub's CLI must not run for a tea host");
      },
      source,
    );
    try {
      await settings.set(
        "sourceControl.preferences",
        {
          hosts: [{ host: "github.com" }, { host: "git.example", forge, account: "alice" }],
          host: "git.example",
          remote: "origin",
        },
        { kind: "global" },
      );
      const link = { threadId: thread.id, pr };
      await expect(
        workspace.execute(
          { type: "forge.comment.reply", link, commentId: 5, body: "Thanks" },
          root,
          () => true,
          "reply",
        ),
      ).rejects.toMatchObject({ kind: "unsupported" });
      await expect(
        workspace.execute(
          { type: "forge.review.request", link, reviewers: ["bob"] },
          root,
          () => true,
          "request",
        ),
      ).rejects.toMatchObject({ kind: "unsupported" });
      expect(writes).toEqual([]);
      const merged = await workspace.execute(
        { type: "forge.pr.merge", link, headSha: head, method: "squash" },
        root,
        () => true,
        "merge",
      );
      expect(merged).toMatchObject({ ok: true });
      expect(writes.map((write) => [write.args[1], JSON.parse(write.input ?? "{}").do])).toEqual([
        ["repos/team/app/pulls/7/merge", "squash"],
      ]);
    } finally {
      workspace.close();
      source.close();
      await settings.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

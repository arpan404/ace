// A real edge: SQLite issue-action journal, settings, SourceControl's pinned glab identity and
// local Git remote routing, across a daemon restart. Only the glab CLI is a stand-in, answering
// with hand-made `glab api --include` replies from GitLab's API documentation.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { CommandRequest, CommandRunner } from "@ace/forge";
import { Command, Thread, WorkspaceActionRequest, type ForgeIssueWrite } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { ProjectRepositoryConfigs } from "./project-repository-config.ts";
import { SourceControl } from "./source-control.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const repository = {
  forge: "gitlab",
  host: "gitlab.com",
  owner: "group/sub",
  name: "repo",
} as const;
const root = "projects/group%2Fsub%2Frepo";
const issue = {
  iid: 7,
  title: "New",
  description: "Draft",
  state: "opened",
  author: { id: 1, username: "sam" },
  labels: [],
  assignees: [],
  milestone: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
function reply(body: unknown, status = 200) {
  return {
    code: status < 400 ? 0 : 1,
    stdout: `HTTP/2.0 ${status} X\r\nx-total: 1\r\nx-next-page: \r\n\r\n${JSON.stringify(body)}`,
    truncated: false,
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ace-gitlab-issues-"));
  await execute("git", ["init", "-q", "-b", "main", dir]);
  await execute("git", ["-C", dir, "remote", "add", "origin", "git@gitlab.com:group/sub/repo.git"]);
  const settings = new SettingsService({ dataDir: dir });
  await settings.set(
    "sourceControl.preferences",
    {
      hosts: [{ host: "gitlab.com", forge: "gitlab", account: "sam" }],
      host: "gitlab.com",
      remote: "origin",
    },
    { kind: "global" },
  );
  const store = new Store(join(dir, "events.sqlite"));
  const workspaceId = store.createWorkspace(dir, "Project");
  const glab = { account: "sam", writeStatus: 200, switchDuringWrite: false, landed: false };
  const requests: CommandRequest[] = [];
  const writes: { args: readonly string[]; body: unknown }[] = [];
  const runner: CommandRunner = async (request) => {
    if (request.command !== "glab") throw new Error("only glab is reached");
    requests.push(request);
    const path = request.args[1] ?? "";
    if (request.input !== undefined) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push({ args: request.args, body: JSON.parse(request.input) });
      if (glab.switchDuringWrite) glab.account = "other";
      glab.landed = true;
      return reply(issue, glab.writeStatus);
    }
    if (path === "user")
      return reply({ id: glab.account === "sam" ? 1 : 2, username: glab.account });
    if (path === root)
      return reply({
        archived: false,
        issues_enabled: true,
        permissions: { project_access: { access_level: 40 } },
      });
    if (path.startsWith(`${root}/issues/7/notes?`))
      return reply([
        { id: 10, body: "hi", system: false, author: issue.author, created_at: issue.created_at },
      ]);
    if (path.startsWith(`${root}/issues?scope=all&state=all`))
      return reply(
        glab.landed
          ? [{ ...issue, description: "Draft\n\n<!-- ace-issue-action:original -->" }]
          : [],
      );
    if (path.startsWith(`${root}/issues?`)) return reply([issue]);
    if (path === `${root}/issues/7`) return reply(issue);
    return reply({ message: "404 Not Found" }, 404);
  };
  const source = new SourceControl(settings, () => runner, dir);
  const options = { sourceControl: source, forgeRunner: () => runner };
  let runtime = new WorkspaceRuntime(store, dir, () => 1000, options);
  const command = (id: string, payload: Record<string, unknown>) =>
    Command.parse({ id, deviceId: "device", payload: { workspaceId, repository, ...payload } });
  return {
    glab,
    store,
    workspaceId,
    requests,
    writes,
    write: (id: string, input: ForgeIssueWrite) =>
      runtime.execute(command(id, { type: "forge.issue.write", input })),
    reconcile: (id: string, actionId: string) =>
      runtime.execute(command(id, { type: "forge.issue.reconcile", actionId })),
    execute: (input: Command) => runtime.execute(input),
    read: (operation: Record<string, unknown>) =>
      runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "read",
          operation: { workspaceId, repository, ...operation },
        }),
      ),
    async restart() {
      await runtime.close();
      runtime = new WorkspaceRuntime(store, dir, () => 2000, options);
    },
    async close() {
      await runtime.close();
      source.close();
      await settings.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const create = { action: "create", title: "New", body: "Draft" } as const;
const exactCreate = [
  "api",
  `${root}/issues`,
  "-X",
  "POST",
  "--hostname",
  "gitlab.com",
  "--include",
  "--input",
  "-",
];

test("a GitLab create whose answer was lost survives a restart, fences a retry and settles by a read", async () => {
  const f = await setup();
  try {
    f.glab.writeStatus = 502;
    expect(await f.write("original", create)).toMatchObject({
      ok: false,
      issueAction: { state: "uncertain" },
    });
    await f.restart();
    expect(await f.read({ op: "forge.issue.actions", number: 0 })).toMatchObject({
      result: { data: { actions: [{ id: "original", state: "uncertain" }] } },
    });
    expect(await f.write("repeat", create)).toMatchObject({
      ok: false,
      error: "issue_reconciliation_required",
    });
    expect(await f.reconcile("settle", "original")).toMatchObject({
      ok: true,
      issueAction: { state: "succeeded" },
      issue: { repository, number: 7 },
    });
    expect(f.writes).toEqual([
      {
        args: exactCreate,
        body: { title: "New", description: "Draft\n\n<!-- ace-issue-action:original -->" },
      },
    ]);
  } finally {
    await f.close();
  }
});

test("a glab account switched during a write never reports success", async () => {
  const f = await setup();
  try {
    f.glab.switchDuringWrite = true;
    expect(await f.write("switch", create)).toMatchObject({
      ok: false,
      issueAction: { state: "uncertain" },
    });
    expect(f.writes).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a glab account switched before a write refuses it unsent", async () => {
  const f = await setup();
  try {
    await f.read({ op: "forge.issue.detail", number: 7 });
    f.glab.account = "other";
    const result = await f.write("comment", { action: "comment", number: 7, body: "Hi" });
    expect(result).toMatchObject({ ok: false, issueAction: { state: "failed" } });
    expect(f.writes).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a hidden GitLab repository refuses issue writes before glab runs", async () => {
  const f = await setup();
  try {
    new ProjectRepositoryConfigs(f.store).set(f.workspaceId, {
      hidden: [repository],
      added: [],
      primary: null,
    });
    expect(await f.write("hidden", create)).toMatchObject({
      ok: false,
      error: "repository_hidden",
    });
    expect(f.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

test("GitLab issues list, open and link to a thread, kept apart from merge requests after a restart", async () => {
  const f = await setup();
  try {
    const thread = Thread.parse({
      id: "task",
      workspaceId: f.workspaceId,
      title: "Issue",
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    const link = Command.parse({
      id: "link",
      deviceId: "device",
      payload: { type: "forge.issue.link", threadId: thread.id, issue: { repository, number: 7 } },
    });
    expect(await f.execute(link)).toMatchObject({ ok: true });
    await f.restart();
    expect(f.store.getThread(thread.id)?.details?.linkedIssues).toEqual([
      { repository, number: 7 },
    ]);
    expect(f.store.getThread(thread.id)?.details?.linkedPrs).toBeUndefined();
    expect(await f.read({ op: "forge.issue.list", query: {} })).toMatchObject({
      result: {
        data: { value: { items: [{ ref: { number: 7 } }], counts: { open: 1, closed: 1 } } },
      },
    });
    expect(await f.read({ op: "forge.issue.detail", number: 7 })).toMatchObject({
      result: {
        data: {
          value: {
            body: "Draft",
            url: "https://gitlab.com/group/sub/repo/-/issues/7",
            relatedThreads: [{ id: "task" }],
          },
        },
      },
    });
    expect(await f.read({ op: "forge.issue.timeline", number: 7 })).toMatchObject({
      result: { data: { events: [{ kind: "issue_comment", body: "hi" }] } },
    });
    expect(f.writes).toEqual([]);
  } finally {
    await f.close();
  }
});

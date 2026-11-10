import { ProjectRepositoryConfigs } from "./project-repository-config.ts";
// Real SQLite journal, settings, and local Git routing; only the external glab CLI is substituted.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { Command, Thread, WorkspaceActionRequest } from "@ace/protocol";
import type { CommandRequest, CommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);
const repository = { forge: "gitlab", host: "gitlab.com", owner: "group/sub", name: "repo" } as const;
const apiRoot = "projects/group%2Fsub%2Frepo";
const issue = { iid: 7, title: "New", description: "Draft", state: "opened", author: { id: 1, username: "sam" },
  labels: [], assignees: [], milestone: null, created_at: "2026-01-01", updated_at: "2026-01-02" };
function reply(body: unknown, status = 200) {
  return { code: status < 400 ? 0 : 1, stdout: `HTTP/2.0 ${status} OK\r\nx-total: 1\r\nx-next-page: \r\n\r\n${JSON.stringify(body)}`, truncated: false };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-gitlab-issues-"));
  await execute("git", ["init", "-q", "-b", "main", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "git@gitlab.com:group/sub/repo.git"]);
  const settings = new SettingsService({ dataDir: root });
  await settings.set("sourceControl.preferences", { hosts: [{ host: "gitlab.com", forge: "gitlab", account: "sam" }], host: "gitlab.com", remote: "origin" }, { kind: "global" });
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  let account = "sam";
  let lostReply = false;
  let switchOnWrite = false;
  const writes: CommandRequest[] = [];
  const runner: CommandRunner = async request => {
    const path = request.args[1] ?? "";
    if (request.command !== "glab") throw new Error("Wrong CLI");
    if (request.input !== undefined) {
      request.dispatch?.prepare?.(); request.dispatch?.record(); writes.push(request);
      if (switchOnWrite) account = "other";
      return reply(issue, lostReply ? 500 : 200);
    }
    if (path === "user") return reply({ id: account === "sam" ? 1 : 2, username: account });
    if (path === apiRoot) return reply({ archived: false, issues_enabled: true, permissions: { project_access: { access_level: 40 } } });
    if (path.includes("/notes?")) return reply([{ id: 10, body: "hi", system: false, author: issue.author, created_at: issue.created_at }]);
    if (path.includes("scope=all&state=all")) return reply([{ ...issue, description: "Draft\n\n<!-- ace-issue-action:original -->" }]);
    if (path.includes("/issues?")) return reply([issue]);
    return reply(issue);
  };
  const source = new SourceControl(settings, () => runner, root);
  const options = { sourceControl: source, forgeRunner: () => runner };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  return { store, source, settings, workspaceId, root, writes,
    get runtime() { return runtime; },
    loseReply() { lostReply = true; }, switchDuringWrite() { switchOnWrite = true; },
    async restart() { await runtime.close(); runtime = new WorkspaceRuntime(store, root, () => 2000, options); },
    command(id: string) { return Command.parse({ id, deviceId: "device", payload: { type: "forge.issue.write", workspaceId, repository, input: { action: "create", title: "New", body: "Draft" } } }); },
    read(operation: Record<string, unknown>) { return runtime.read(WorkspaceActionRequest.parse({ type: "workspace.request", requestId: "read", operation: { workspaceId, repository, ...operation } })); },
    async close() { await runtime.close(); source.close(); await settings.close(); await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("GitLab lost create survives restart, blocks replay and settles by a marker read", async () => {
  const f = await setup();
  try {
    f.loseReply();
    const first = await f.runtime.execute(f.command("original"));
    expect(first).toMatchObject({ ok: false, issueAction: { state: "uncertain" } });
    await f.restart();
    expect(await f.read({ op: "forge.issue.actions", number: 0 })).toMatchObject({ result: { data: { actions: [{ id: "original", state: "uncertain" }] } } });
    expect(await f.runtime.execute(f.command("repeat"))).toMatchObject({ ok: false, error: "issue_reconciliation_required" });
    expect(await f.runtime.execute(Command.parse({ id: "reconcile", deviceId: "device", payload: { type: "forge.issue.reconcile", workspaceId: f.workspaceId, repository, actionId: "original" } }))).toMatchObject({ ok: true, issueAction: { state: "succeeded" }, issue: { number: 7 } });
    expect(f.writes).toHaveLength(1);
  } finally { await f.close(); }
});
test("switching the glab account during a write never publishes success", async () => {
  const f = await setup();
  try {
    f.switchDuringWrite();
    expect(await f.runtime.execute(f.command("switch"))).toMatchObject({ ok: false, issueAction: { state: "uncertain" } });
    expect(f.writes).toHaveLength(1);
    expect(await f.runtime.execute(f.command("after-switch"))).toMatchObject({ ok: false });
    expect(f.writes).toHaveLength(1);
  } finally { await f.close(); }
});
test("a hidden GitLab repository refuses issue writes before glab dispatch", async () => {
  const f = await setup();
  try {
    new ProjectRepositoryConfigs(f.store).set(f.workspaceId, { hidden: [repository], added: [], primary: null });
    expect(await f.runtime.execute(f.command("hidden"))).toMatchObject({ ok: false, error: "repository_hidden" });
    expect(f.writes).toHaveLength(0);
  } finally { await f.close(); }
});
test("GitLab browse and issue linking keep issue and MR identities separate after restart", async () => {
  const f = await setup();
  try {
    const thread = Thread.parse({ id: "task", workspaceId: f.workspaceId, title: "Issue", provider: "codex", status: { state: "new" }, createdAt: 1, updatedAt: 1 });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    expect(await f.runtime.execute(Command.parse({ id: "link", deviceId: "device", payload: { type: "forge.issue.link", threadId: thread.id, issue: { repository, number: 7 } } }))).toMatchObject({ ok: true });
    await f.restart();
    expect(f.store.getThread(thread.id)?.details?.linkedIssues).toEqual([{ repository, number: 7 }]);
    expect(f.store.getThread(thread.id)?.details?.linkedPrs).toBeUndefined();
    expect(await f.read({ op: "forge.issue.detail", number: 7 })).toMatchObject({ result: { data: { value: { body: "Draft", relatedThreads: [{ id: "task" }] } } } });
    expect(await f.read({ op: "forge.issue.list", query: {} })).toMatchObject({ result: { data: { value: { items: [{ ref: { number: 7 } }] } } } });
    expect(await f.read({ op: "forge.issue.timeline", number: 7 })).toMatchObject({ result: { data: { events: [{ kind: "issue_comment", body: "hi" }] } } });
  } finally { await f.close(); }
});

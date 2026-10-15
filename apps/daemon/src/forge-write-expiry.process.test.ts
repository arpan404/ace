import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Thread, type CommandPayload } from "@ace/protocol";
import {
  fakeGh,
  issueRecord,
  mergeStateResponse,
  nextSha,
  pr,
  repository,
  sha,
  standard,
  threads,
  type Fixtures,
} from "@ace/forge/testing";
import { ForgeStore, uncertainWriteWindowMs } from "@ace/forge";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { IssueActions } from "./issue-actions.ts";

const execute = promisify(execFile);
const path = "repos/octo/ace/pulls/7";
const link = { threadId: "expiry-thread", pr: { repository, number: 7 } };
const review = {
  type: "forge.review.request",
  link,
  reviewers: ["octo"],
} satisfies CommandPayload;
const merge = {
  type: "forge.pr.merge",
  link,
  headSha: sha,
  method: "squash",
} satisfies CommandPayload;
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

async function prEnvironment(records: Fixtures) {
  const gh = await fakeGh(records);
  const root = await mkdtemp(join(tmpdir(), "ace-write-expiry-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: link.threadId,
    workspaceId,
    title: "Expiry",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  store.atomic((db) => new ForgeStore(db).link(link));
  const clock = { now: 1_000 };
  const runtime = new WorkspaceRuntime(store, root, () => clock.now, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  return {
    gh,
    clock,
    command(id: string, payload: CommandPayload) {
      return runtime.execute(Command.parse({ id, deviceId: "device", payload }), () => true);
    },
    async writes() {
      return (
        (await gh.requests())
          // GraphQL reads are POSTs too; only REST writes count here.
          .filter((request) => request.path.startsWith("repos/"))
          .filter((request) => request.args.includes("POST") || request.args.includes("PUT"))
          .map((request) => request.path)
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

test("an uncertain write expires and later actions proceed", async () => {
  const records = standard();
  records[path] = [{ body: hosted }];
  records["merge-state-read"] = [mergeStateResponse()];
  records.graphql = [{ body: threads() }];
  // The first request is lost; GitHub never shows the reviewer.
  records[`${path}/requested_reviewers`] = [
    { status: 503, code: 1 },
    { body: { requested_reviewers: [{ login: "octo" }] } },
  ];
  records[`${path}/merge`] = [{ body: { merged: true } }];
  const app = await prEnvironment(records);
  try {
    expect(await app.command("lost", review)).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    // Within the window the same write is never repeated.
    expect(await app.command("retry", review)).toMatchObject({
      ok: false,
      error: "forge_write_uncertain",
    });
    // A different kind of write on the same PR is not fenced by it.
    expect(await app.command("merge", merge)).toMatchObject({ ok: true });
    app.clock.now += uncertainWriteWindowMs;
    // A complete read past the window still shows no reviewer: the write never landed.
    expect(await app.command("after-window", review)).toMatchObject({ ok: true });
    expect(await app.writes()).toEqual([
      `${path}/requested_reviewers`,
      `${path}/merge`,
      `${path}/requested_reviewers`,
    ]);
  } finally {
    await app.close();
  }
});

const repoPath = "repos/octo/ace";
const lookupPath = `${repoPath}/issues?state=all&sort=created&direction=desc&per_page=100&page=1`;
function issueCommand(id: string, deviceId: string, payload: unknown) {
  return Command.parse({ id, deviceId, payload });
}
const create = {
  type: "forge.issue.write",
  workspaceId: "workspace",
  repository,
  input: { action: "create", title: "Draft", body: "Context" },
} as const;
const reconcile = (actionId: string) =>
  ({ type: "forge.issue.reconcile", workspaceId: "workspace", repository, actionId }) as const;

test("an uncertain issue create that never landed stops blocking creates once another device reconciles it", async () => {
  const gh = await fakeGh({
    [repoPath]: [{ body: { archived: false, has_issues: true } }],
    [`${repoPath}/issues`]: [{ status: 502 }, { body: issueRecord }],
    [lookupPath]: [{ body: [] }],
  });
  const root = await mkdtemp(join(tmpdir(), "ace-issue-expiry-"));
  const store = new Store(join(root, "events.sqlite"));
  let clock = 1_000;
  const actions = new IssueActions(store, () => clock);
  const signal = new AbortController().signal;
  const run = (command: Command) => actions.execute(command, gh.forge, () => true, signal);
  try {
    expect(await run(issueCommand("lost", "laptop", create))).toMatchObject({
      ok: false,
      issueAction: { id: "lost", state: "uncertain" },
    });
    expect(await run(issueCommand("blocked", "laptop", create))).toMatchObject({
      ok: false,
      code: "action_not_dispatched",
    });
    // The laptop is gone; the phone may settle the action, but not before the window ends.
    expect(await run(issueCommand("early", "phone", reconcile("lost")))).toMatchObject({
      ok: false,
      issueAction: { state: "uncertain" },
    });
    clock += uncertainWriteWindowMs;
    expect(await run(issueCommand("settle", "phone", reconcile("lost")))).toMatchObject({
      ok: false,
      issueAction: { id: "lost", state: "failed", error: "action_not_observed" },
    });
    expect(await run(issueCommand("fresh", "phone", create))).toMatchObject({
      ok: true,
      issue: { number: 7 },
    });
  } finally {
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

import { seedForgeBrowse } from "@ace/fake-daemon";
import { WorkspaceId, type CommandPayload, type ThreadListEntry } from "@ace/protocol";
import { issueQuery } from "@ace/ui-core";
import { afterEach, expect, test } from "vitest";
import type { ForgeOwner } from "./forge-reads.ts";
import { ForgeService, type ForgeRequest } from "./forge-service.ts";
import type { PullsReply, IssuesReply } from "./forge-lists.ts";
import type { PullReply } from "./forge-pull.ts";
import type { IssueReply } from "./forge-issue.ts";
import { NativeServices } from "./native-services.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;

/** The fake daemon's `ace` repository on GitHub, read by a phone runtime. */
async function connected(threads?: ThreadListEntry[]) {
  const { daemon, client } = sheetFixture();
  seedForgeBrowse(daemon, Date.parse("2026-10-20T00:00:00Z"));
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const sent: CommandPayload[] = [];
  const owner: ForgeOwner = {
    request: client.request.bind(client),
    command: (payload) => {
      sent.push(payload);
      return client.command(payload);
    },
    threads: threads
      ? () =>
          ({
            store: {
              ids: threads.map((thread) => thread.id),
              thread: (id: string) => threads.find((thread) => thread.id === id),
            },
            release() {},
          }) as unknown as ReturnType<ForgeOwner["threads"]>
      : () => client.threads(),
  };
  const forge = new ForgeService(owner, plainPreview, () => 0);
  const ask = (request: Record<string, unknown>) =>
    forge.answer({ fresh: false, ...request } as ForgeRequest, new AbortController().signal);
  return { daemon, client, sent, ask };
}

const numbers = (reply: PullsReply | IssuesReply) =>
  Object.fromEntries(reply.groups.map((group) => [group.id, group.rows.map((row) => row.number)]));

test("open pull requests come grouped by what each needs next, each row with its step, marks and coloured labels", async () => {
  const { ask } = await connected();
  const pulls = (await ask({ type: "forge.pulls", project: "ace", search: {} })) as PullsReply;
  expect(pulls.groups.map((group) => group.label)).toEqual([
    "Needs you",
    "Ready to merge",
    "Waiting",
    "Drafts",
  ]);
  expect(pulls.counts).toEqual({ open: 7, merged: 1, closed: 1 });
  const rows = pulls.groups.flatMap((group) => group.rows);
  expect(rows.find((row) => row.number === 229)).toMatchObject({
    step: "Review",
    stepNeedsYou: true,
    review: { word: "Changes requested", tone: "failed" },
    checks: { word: "Checks failing", tone: "failed" },
    labels: [
      { name: "bug", color: "d73a4a" },
      { name: "client", color: "5319e7" },
    ],
  });
  expect(rows.find((row) => row.number === 231)).toMatchObject({
    step: null,
    quiet: "Checks running",
  });
  expect(numbers(pulls).merge).toEqual([233, 224]);
});

test("sorted by activity, pull requests group as yours, asking for your review, and the rest, with GitHub's totals", async () => {
  const { ask } = await connected();
  const pulls = (await ask({
    type: "forge.pulls",
    project: "ace",
    search: { sort: "updated" },
  })) as PullsReply;
  expect(pulls.groups.map((group) => group.id)).toEqual(["authored", "reviewing", "others"]);
  for (const group of pulls.groups) expect(group.count).toBe(group.rows.length);
});

test("Merged lists the merged pull requests", async () => {
  const { ask } = await connected();
  const pulls = (await ask({
    type: "forge.pulls",
    project: "ace",
    search: { state: "merged" },
  })) as PullsReply;
  const rows = pulls.groups.flatMap((group) => group.rows);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ merged: true, state: { word: "Merged", tone: "waiting" } });
});

test("issues group as assigned to you, opened by you, and the rest, and the Filters menu offers their authors and labels", async () => {
  const { ask } = await connected();
  const issues = (await ask({ type: "forge.issues", project: "ace", search: {} })) as IssuesReply;
  expect(numbers(issues)).toEqual({ assigned: [240], created: [235], others: [238] });
  expect(issues.counts).toEqual({ open: 3, closed: 1 });
  expect(issues.authors).toContain("mira");
  expect(issues.labels).toContain("bug");
});

test("a list read again within half a minute is answered from memory until the person refreshes", async () => {
  const { daemon, ask } = await connected();
  const issues = { type: "forge.issues", project: "ace", search: { state: "closed" } };
  const read = {
    op: "forge.issue.list",
    workspaceId: WorkspaceId.parse("ace"),
    query: issueQuery({ state: "closed" }, 1),
  } as const;
  await ask(issues);
  await ask(issues);
  expect(daemon.workspace.forgeReadCount(read)).toBe(1);
  await ask({ ...issues, fresh: true });
  expect(daemon.workspace.forgeReadCount(read)).toBe(2);
});

test("a ready pull request's page offers its merge, and merging through its project marks it merged", async () => {
  const { ask, sent } = await connected();
  const page = (await ask({
    type: "forge.pull",
    project: "ace",
    number: 233,
    repository,
    method: "rebase",
  })) as PullReply;
  expect(page.gates.map((gate) => [gate.label, gate.tone])).toEqual([
    ["Checks", "done"],
    ["Reviews", "done"],
    ["Conflicts", "done"],
    ["Branch", "done"],
  ]);
  expect(page.action).toEqual({ kind: "merge", label: "Rebase and merge", disabled: null });
  const merged = await ask({
    type: "forge.merge",
    project: "ace",
    number: 233,
    repository,
    method: "rebase",
    headSha: page.headSha,
  });
  expect(merged).toEqual({ type: "forge.write", ok: true, message: "Merged" });
  expect(sent).toEqual([
    {
      type: "forge.hosted.merge",
      workspaceId: "ace",
      pr: { repository, number: 233 },
      headSha: page.headSha,
      method: "rebase",
    },
  ]);
  const after = (await ask({
    type: "forge.pull",
    project: "ace",
    number: 233,
    repository,
  })) as PullReply;
  expect(after).toMatchObject({ merged: true, action: null });
  const open = (await ask({ type: "forge.pulls", project: "ace", search: {} })) as PullsReply;
  expect(open.groups.flatMap((group) => group.rows).map((row) => row.number)).not.toContain(233);
});

test("a merge pinned to a head GitHub has moved past is refused in the web's words", async () => {
  const { ask } = await connected();
  const reply = await ask({
    type: "forge.merge",
    project: "ace",
    number: 233,
    repository,
    method: "squash",
    headSha: "a".repeat(40),
  });
  expect(reply).toMatchObject({ type: "forge.write", ok: false });
  expect((reply as { message: string }).message).not.toBe("");
});

test("a pull request a thread works on merges through that thread's link", async () => {
  const thread = {
    id: "thread-1",
    title: "Keep drafts per project",
    status: { state: "working" },
    details: { linkedPrs: [{ repo: repository, number: 233 }], linkedIssues: [] },
  } as unknown as ThreadListEntry;
  const { ask, sent } = await connected([thread]);
  const list = (await ask({ type: "forge.pulls", project: "ace", search: {} })) as PullsReply;
  const row = list.groups.flatMap((group) => group.rows).find((each) => each.number === 233);
  expect(row?.thread).toEqual({
    id: "thread-1",
    title: "Keep drafts per project",
    needsYou: false,
  });
  await ask({
    type: "forge.auto-merge",
    project: "ace",
    number: 233,
    repository,
    method: "squash",
    headSha: "e".repeat(39) + "9",
    action: "enable",
  });
  expect(sent[0]).toMatchObject({
    type: "forge.pr.merge-state.change",
    link: { threadId: "thread-1", pr: { repository, number: 233 } },
    action: "enable",
  });
});

test("an issue's page carries its conversation and what a thread started from it opens with", async () => {
  const { ask } = await connected();
  const issue = (await ask({
    type: "forge.issue",
    project: "ace",
    number: 240,
  })) as IssueReply;
  expect(issue.title).toBe("Sidebar loses its scroll position after archiving");
  expect(issue.start.issue).toEqual({ repository, number: 240 });
  expect(
    issue.start.text.startsWith(`Work on GitHub issue #240: ${issue.title}\n${issue.url}`),
  ).toBe(true);
  expect(issue.events.some((event) => event.comment && event.body)).toBe(true);
});

test("the phone asks for forge lists through its native service call and gets a refusal as a sentence", async () => {
  const { client } = await connected();
  const sink = new RecordingSink();
  const services = new NativeServices(
    client,
    sink,
    undefined,
    undefined,
    undefined,
    new ForgeService(client, plainPreview, () => 0),
  );
  services.handle({
    type: "service",
    id: "pulls",
    request: { type: "forge.pulls", project: "ace", search: { sort: "largest" } },
  });
  await until(() => sink.read("service:pulls") !== undefined, "pulls answered");
  expect(sink.read("service:pulls")).toMatchObject({ ok: true, value: { type: "forge.pulls" } });
  services.handle({
    type: "service",
    id: "missing",
    request: { type: "forge.pull", project: "ace", number: 9999, repository },
  });
  await until(() => sink.read("service:missing") !== undefined, "refused");
  const refused = sink.read("service:missing");
  expect(refused).toMatchObject({ ok: false });
  expect(String(refused?.message)).not.toBe("");
});

test("the lists' project chip names the machine's projects, read as New thread reads them", async () => {
  const { daemon, ask } = await connected();
  daemon.createThread({ id: "in-ace", workspaceId: "ace", title: "Work", provider: "claude" });
  const reply = (await ask({ type: "forge.projects" })) as { projects: { id: string }[] };
  expect(reply.projects.map((project) => project.id)).toContain("ace");
});

import "./test-host.ts";
import { WorkspaceId, type ForgeBrowserResult } from "@ace/protocol";
import { lockedText } from "@ace/ui-core";
import { expect, test } from "vitest";
import type { FileReply } from "./forge-code.ts";
import type { ReviewWriteReply } from "./forge-review-write.ts";
import type { TimelineReply, TimelineRow } from "./forge-timeline.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * Commenting and reviewing a pull request from the phone, on the fake daemon's GitHub: #31 in
 * acme/docs-site is the viewer's own PR with a changes-requested review and line conversations;
 * #74 in acme/billing-api is someone else's.
 */

const docs = { forge: "github", host: "github.com", owner: "acme", name: "docs-site" } as const;
const billing = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "billing-api",
} as const;
const pr31 = { project: "ace", number: 31, repository: docs };
const pr74 = { project: "ace", number: 74, repository: billing };

type Ask = (request: Record<string, unknown>) => Promise<unknown>;
type Target = { project: string; number: number; repository: { owner: string; name: string } };
const timeline = async (ask: Ask, target: Target = pr31) =>
  (await ask({ type: "forge.pull.timeline", ...target })) as TimelineReply;
const review = async (ask: Ask, action: Record<string, unknown>, target: Target = pr31) =>
  (await ask({ type: "forge.review", ...target, action })) as ReviewWriteReply;
const commentRow = (reply: TimelineReply, id: string) =>
  reply.rows.find(
    (row): row is Extract<TimelineRow, { kind: "comment" }> =>
      row.kind === "comment" && row.comment.id === id,
  );

test("the timeline shows comments, reviews and line conversations oldest first, each with what this account may do", async () => {
  const { ask } = await connected();
  const reply = await timeline(ask);
  expect(reply.unread).toBeNull();
  expect(reply.box).toEqual({ off: null });
  // The viewer's own comment, hidden as outdated: it can be edited, deleted and shown again.
  expect(commentRow(reply, "issue:320")?.comment).toMatchObject({
    author: "you",
    hidden: "Hidden as outdated",
    edit: true,
    remove: true,
    unhide: true,
    hide: false,
    url: "https://github.com/acme/docs-site/pull/31#issuecomment-320",
  });
  // Someone else's: quote reply and reactions, but no edit or delete.
  const theirs = commentRow(reply, "issue:321")?.comment;
  expect(theirs).toMatchObject({ quote: true, edit: false, remove: false, hidden: null });
  expect(theirs?.reactions.map((reaction) => reaction.label)).toEqual([
    "Thumbs up",
    "Thumbs down",
    "Laugh",
    "Hooray",
    "Confused",
    "Heart",
    "Rocket",
    "Eyes",
  ]);
  const verdict = reply.rows.find((row) => row.kind === "review");
  expect(verdict).toMatchObject({ words: "requested changes", tone: "failed" });
  const thread = reply.rows.find((row) => row.kind === "thread" && row.thread.id === "RT_31");
  expect(thread).toMatchObject({
    thread: { place: "docs/install.md:12", canResolve: true, canReply: true, resolved: false },
  });
  // Oldest first: the opening comes before the conversation it started.
  const at = reply.rows.flatMap((row) =>
    row.kind === "comment" || row.kind === "review" ? [row.comment.at ?? 0] : [],
  );
  expect(at).toEqual(at.toSorted((a, b) => a - b));
});

test("the Review sheet lists the pending line comments and keeps Approve and Request changes off on your own pull request", async () => {
  const { ask } = await connected();
  const sheet = (await timeline(ask)).review;
  expect(sheet?.drafts.map((draft) => draft.place)).toEqual([
    "docs/install.md:7",
    "docs/docker.md:3–5",
  ]);
  expect(sheet?.blocked).toBe("You can't approve or request changes on your own pull request.");
  expect(sheet?.verdicts.map((verdict) => [verdict.label, verdict.off])).toEqual([
    ["Comment", false],
    ["Approve", true],
    ["Request changes", true],
  ]);
});

test("a comment from the box is sent once and shows in the timeline read after it", async () => {
  const { ask, sent } = await connected();
  const written = await review(ask, { kind: "conversation", body: "Checked on a clean machine." });
  expect(written).toMatchObject({ ok: true, uncertain: false });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "forge.hosted.review",
    pr: { repository: docs, number: 31 },
    action: { kind: "conversation", body: "Checked on a clean machine." },
  });
  const after = await timeline(ask);
  expect(
    after.rows.some(
      (row) => row.kind === "comment" && row.comment.body === "Checked on a clean machine.",
    ),
  ).toBe(true);
});

test("an edit replaces only the text the phone showed; a comment never shown is refused without sending", async () => {
  const { ask, sent } = await connected();
  const refused = await review(ask, {
    kind: "comment.edit",
    source: "issue",
    commentId: 320,
    body: "Ports are final now.",
  });
  expect(refused).toMatchObject({ ok: false, uncertain: false });
  expect(sent).toHaveLength(0);
  await timeline(ask);
  const edited = await review(ask, {
    kind: "comment.edit",
    source: "issue",
    commentId: 320,
    body: "Ports are final now.",
  });
  expect(edited.ok).toBe(true);
  expect(sent[0]).toMatchObject({
    action: {
      kind: "comment.edit",
      expectedBody: "First pass is up. Ignore the port numbers for now, they're placeholders.",
    },
  });
  expect(commentRow(await timeline(ask), "issue:320")?.comment.body).toBe("Ports are final now.");
});

test("a review write whose answer is lost is said to be uncertain and is never sent again", async () => {
  const { ask, sent } = await connected(undefined, undefined, () =>
    Promise.reject(new Error("socket closed")),
  );
  const written = await review(ask, { kind: "conversation", body: "Looks good." });
  expect(written).toMatchObject({ ok: false, uncertain: true });
  expect(written.message).toContain("reconcile");
  expect(sent).toHaveLength(1);
});

test("a conversation locked to this account turns the boxes off with the reason and refuses comments unsent", async () => {
  const { ask, sent, daemon, client } = await connected();
  const read = {
    op: "forge.pr.lifecycle",
    workspaceId: WorkspaceId.parse("ace"),
    repository: docs,
    number: 31,
  } as const;
  const reply = await client.request({
    type: "workspace.request",
    requestId: "l",
    operation: read,
  });
  if (reply.result.kind !== "forge" || reply.result.data.resource !== "prLifecycle")
    throw new Error("no lifecycle");
  const lifecycle = reply.result.data.value;
  const locked: ForgeBrowserResult = {
    resource: "prLifecycle",
    value: {
      ...lifecycle,
      snapshot: {
        ...lifecycle.snapshot,
        conversation: { locked: true, reason: "too_heated", viewerCanComment: false },
      },
    },
  };
  daemon.workspace.setForgeRead(read, locked);
  const page = await timeline(ask);
  expect(page.box).toEqual({ off: lockedText });
  expect(page.review?.refused).toBe(lockedText);
  expect(commentRow(page, "issue:321")?.comment).toMatchObject({ quote: false, reactions: [] });
  const written = await review(ask, { kind: "conversation", body: "Calm down, everyone." });
  expect(written).toEqual({
    type: "forge.write",
    ok: false,
    message: lockedText,
    uncertain: false,
  });
  // Resolving a conversation isn't commenting: it still goes through.
  expect((await review(ask, { kind: "thread.resolve", threadId: "RT_31" })).ok).toBe(true);
  expect(
    sent.map((payload) => payload.type === "forge.hosted.review" && payload.action.kind),
  ).toEqual(["thread.resolve"]);
});

const lineAt = (reply: FileReply, line: number, side: "LEFT" | "RIGHT") =>
  reply.lines.find((each) => each.anchor?.line === line && each.anchor.side === side);

test("the code view puts each conversation and pending comment under its line, and a new line comment lands there", async () => {
  const { ask } = await connected();
  const file = async () =>
    (await ask({
      type: "forge.pull.file",
      ...pr31,
      path: "docs/install.md",
      index: 0,
    })) as FileReply;
  const before = await file();
  expect(before.commenting).toEqual({ off: null });
  expect(lineAt(before, 12, "RIGHT")?.threads.map((thread) => thread.id)).toEqual(["RT_31"]);
  expect(lineAt(before, 4, "LEFT")?.threads.map((thread) => thread.id)).toEqual(["RT_33"]);
  expect(lineAt(before, 7, "RIGHT")?.drafts.map((draft) => draft.id)).toEqual(["draft-stop"]);
  const written = await review(ask, {
    kind: "line.comment",
    headSha: before.headSha,
    anchor: { commit: before.headSha, path: "docs/install.md", line: 9, side: "RIGHT" },
    body: "```suggestion\nace start --service\n```",
  });
  expect(written.ok).toBe(true);
  const after = await file();
  expect(lineAt(after, 9, "RIGHT")?.threads[0]?.comments[0]?.body).toContain("```suggestion");
});

test("a pending line comment joins the review and a submitted approval sends it with the verdict", async () => {
  const { ask, sent } = await connected();
  const head = (await timeline(ask, pr74)).review?.headSha ?? "";
  expect((await timeline(ask, pr74)).review?.blocked).toBeNull();
  const saved = await review(
    ask,
    {
      kind: "draft.save",
      draft: {
        body: "Nit: name this locale.",
        anchor: { commit: head, path: "README.md", line: 2, side: "RIGHT" },
      },
    },
    pr74,
  );
  expect(saved.ok).toBe(true);
  const sheet = (await timeline(ask, pr74)).review;
  expect(sheet?.drafts).toEqual([
    { id: "draft-1", place: "README.md:2", body: "Nit: name this locale.", outdated: false },
  ]);
  const submitted = await review(
    ask,
    { kind: "submit", headSha: head, event: "APPROVE", body: "Ship it.", draftIds: ["draft-1"] },
    pr74,
  );
  expect(submitted.ok).toBe(true);
  expect(sent.at(-1)).toMatchObject({
    action: { kind: "submit", event: "APPROVE", draftIds: ["draft-1"] },
  });
  const after = await timeline(ask, pr74);
  expect(after.review?.drafts).toEqual([]);
  expect(after.rows.some((row) => row.kind === "review" && row.words === "approved")).toBe(true);
});

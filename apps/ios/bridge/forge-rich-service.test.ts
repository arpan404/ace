import "./test-host.ts";
import { expect, test } from "vitest";
import type { MediaReply } from "./forge-media-read.ts";
import type { RichBlock } from "./forge-rich.ts";
import type { TimelineReply } from "./forge-timeline.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * Rich text through the phone's forge service, on the fake daemon's GitHub: #245 in acme/ace
 * carries uploads, a recording, and the viewer's own comment with task boxes.
 */

const ace = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const upload = (id: string) => `https://github.com/user-attachments/assets/${id}`;
type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const media = async (ask: Ask, url: string, role = "image") =>
  (await ask({ type: "forge.media", project: "ace", url, role })) as MediaReply;
const timeline = async (ask: Ask) =>
  (await ask({ type: "forge.pull.timeline", project: "ace", number: 245 })) as TimelineReply;
const tasksOf = (reply: TimelineReply, id: string) => {
  const row = reply.rows.find((each) => each.kind === "comment" && each.comment.id === id);
  if (row?.kind !== "comment") throw new Error("no comment");
  const list = row.comment.blocks.find(
    (block): block is Extract<RichBlock, { k: "list" }> => block.k === "list",
  );
  return { comment: row.comment, items: list?.items ?? [] };
};

test("a private upload arrives as bytes through the daemon; a missing one and a plain link say what they are", async () => {
  const { ask } = await connected();
  const ready = await media(ask, upload("2c6a1d2f-7b3e-4f9c-8d22-1b8e4f6a3c52"));
  expect(ready).toMatchObject({ state: "ready", kind: "image", width: 1600, height: 900 });
  expect(ready.state === "ready" && atob(ready.data).startsWith("<svg")).toBe(true);
  expect(await media(ask, upload("4e8c3f4b-9d5a-4b1e-8f44-3d0a6b8c5e74"))).toEqual({
    type: "forge.media",
    state: "unavailable",
    reason: "No longer on GitHub",
  });
  expect(await media(ask, "https://example.com/release-notes", "link")).toEqual({
    type: "forge.media",
    state: "none",
  });
  const video = await media(ask, upload("3d7b2e3a-8c4f-4a0d-9e33-2c9f5a7b4d63"), "link");
  expect(video).toMatchObject({ state: "ready", kind: "video", mimeType: "video/webm" });
});

test("ticking a box in your own comment rewrites only that box, and the next read shows it ticked", async () => {
  const { ask, sent } = await connected();
  const before = tasksOf(await timeline(ask), "issue:2452");
  expect(before.comment.tasks).toBe(true);
  expect(before.items.map((item) => item.task?.checked)).toEqual([false, true]);
  const offset = before.items[0]?.task?.offset;
  const written = (await ask({
    type: "forge.task",
    project: "ace",
    number: 245,
    repository: ace,
    on: { kind: "comment", source: "issue", commentId: 2452 },
    offset,
    checked: true,
  })) as { ok: boolean };
  expect(written.ok).toBe(true);
  expect(sent[0]).toMatchObject({ action: { kind: "comment.edit", commentId: 2452 } });
  const action = sent[0]?.type === "forge.hosted.review" ? sent[0].action : undefined;
  expect(action?.kind === "comment.edit" && action.body).toContain("- [x] Rebase on main");
  expect(
    tasksOf(await timeline(ask), "issue:2452").items.map((item) => item.task?.checked),
  ).toEqual([true, true]);
});

test("someone else's comment shows its boxes without letting them tick", async () => {
  const { ask } = await connected();
  const theirs = (await timeline(ask)).rows.find(
    (row) => row.kind === "comment" && row.comment.id === "issue:2451",
  );
  expect(theirs?.kind === "comment" && theirs.comment.tasks).toBe(false);
});

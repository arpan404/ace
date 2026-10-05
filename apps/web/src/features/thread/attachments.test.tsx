import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import type { Attachment, ContentPart } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Attachments in the transcript (AT-1): thumbnails from the daemon's attachment bytes and file
 * chips by name and size. jsdom has no object URLs, so they are stubbed at that boundary and
 * remember the blob each one stands for.
 */

const objectUrls = new Map<string, Blob>();
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  let next = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:test/${++next}`;
    if (blob instanceof Blob) objectUrls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void objectUrls.delete(url);
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
  objectUrls.clear();
});

const fixtureBytes = atob(fixtureImage.data).length;
const dot =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=";

/** A settled thread whose one user message carries `draft`'s parts and attachments. */
async function openMessage(
  draft: { parts?: ContentPart[]; attachments?: Attachment[] },
  extra: Parameters<FakeDaemon["apply"]>[1] = [],
) {
  const app = harness();
  app.daemon.createThread({
    id: "thread-shots",
    workspaceId: "shop",
    title: "Screenshots",
    provider: "codex",
    details: { worktree: "/work/shop" },
  });
  app.daemon.seedServices({ attachmentImages: [{ threadId: "thread-shots", name: "home.png" }] });
  app.daemon.apply("thread-shots", [
    facts.rootAgent("codex", "/work/shop"),
    facts.turn("root"),
    {
      type: "item.upsert",
      agent: "root",
      item: "ask",
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "What changed here?" }, ...(draft.parts ?? [])],
        ...(draft.attachments ? { attachments: draft.attachments } : {}),
      },
    },
    ...extra,
    facts.endTurn("root"),
  ]);
  await app.open("/t/thread-shots");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("What changed here?");
  return { app, feed };
}

const home: Attachment = {
  sha256: fixtureImage.sha256,
  bytes: fixtureBytes,
  mimeType: "image/png",
  name: "home.png",
  width: 120,
  height: 80,
  thumbnailAvailable: true,
};

test("an attached image shows as a thumbnail of its own bytes, named, never as a host path", async () => {
  const { feed } = await openMessage({
    attachments: [home],
    // A provider echo of the stored blob, as older rows carry it.
    parts: [{ type: "file", path: `/Users/dev/.ace-next/context/blobs/${"c".repeat(64)}` }],
  });
  const image = await within(feed).findByRole("img", { name: "home.png" });
  const blob = objectUrls.get(image.getAttribute("src") ?? "");
  expect(blob?.size).toBe(fixtureBytes);
  expect(blob?.type).toBe("image/png");
  expect(feed.textContent).not.toContain("/Users/");
  expect(feed.textContent).not.toContain("c".repeat(64));
});

test("an image whose bytes this device can't reach reads as unavailable, with its name", async () => {
  const { feed } = await openMessage({
    attachments: [{ ...home, sha256: "a".repeat(64), name: "lost.png" }],
  });
  expect(
    await within(feed).findByRole("img", { name: "lost.png: image unavailable on this device" }),
  ).toBeTruthy();
  expect(within(feed).queryByRole("img", { name: "lost.png" })).toBeNull();
});

test("files show their name, size and type, never the path they were stored at", async () => {
  const { feed } = await openMessage({
    attachments: [
      { sha256: "b".repeat(64), bytes: 1_200_000, mimeType: "application/pdf", name: "report.pdf" },
    ],
    parts: [{ type: "file", path: "/Users/dev/acme/notes/plan.md" }],
  });
  const files = await within(feed).findByRole("list", { name: "Attached files" });
  expect(within(files).getByText("report.pdf · 1.2 MB")).toBeTruthy();
  expect(within(files).getByText("plan.md")).toBeTruthy();
  expect(feed.textContent).not.toContain("/Users/");
});

test("more than four images show three and a +N tile", async () => {
  const { feed } = await openMessage({
    parts: Array.from({ length: 5 }, () => ({ type: "image", mimeType: "image/png", url: dot })),
  });
  const grid = await within(feed).findByRole("list", { name: "5 images" });
  expect(within(grid).getAllByRole("img", { name: "Attached image" })).toHaveLength(3);
  expect(within(grid).getByRole("img", { name: "2 more images" })).toBeTruthy();
});

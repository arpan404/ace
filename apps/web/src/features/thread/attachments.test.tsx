import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import type { Attachment, ContentPart } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Attachments in the transcript (AT-1, AT-2, AT-3): thumbnails from the daemon's attachment
 * bytes, file chips by name and size, the lightbox, and files the agent saved. jsdom has no
 * object URLs, so they are stubbed at that boundary and remember the blob each one stands for.
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
  expect(within(files).getByRole("button", { name: "report.pdf, 1.2 MB · PDF" })).toBeTruthy();
  // A path the agent named is a label: this device has no bytes to open.
  expect(within(files).getByLabelText("plan.md, Markdown").tagName).toBe("SPAN");
  expect(feed.textContent).not.toContain("/Users/");
});

test("a sent file says how the agent received it, and its tooltip explains", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({
    attachments: [
      {
        sha256: "d".repeat(64),
        bytes: 48_000,
        mimeType: "text/plain",
        name: "server.log",
        kind: "text",
        delivery: "inline_text_and_path",
      },
      {
        sha256: "e".repeat(64),
        bytes: 1_200_000,
        mimeType: "application/pdf",
        name: "spec.pdf",
        kind: "pdf",
        delivery: "native_pdf",
      },
      {
        sha256: "f".repeat(64),
        bytes: 9_000_000,
        mimeType: "application/zip",
        name: "logs.zip",
        kind: "binary",
        delivery: "file_path",
      },
    ],
  });
  const files = await within(feed).findByRole("list", { name: "Attached files" });
  const log = within(files).getByRole("button", {
    name: "server.log, 48 KB · Log · inline text, truncated",
  });
  expect(
    within(files).getByRole("button", { name: "spec.pdf, 1.2 MB · PDF · native PDF" }),
  ).toBeTruthy();
  expect(
    within(files).getByRole("button", {
      name: "logs.zip, 9.0 MB · ZIP archive · sent as file path",
    }),
  ).toBeTruthy();
  await user.hover(log);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "The first 16 KB of text went into the message, with a path to the rest",
  );
});

test("more than four images show three and a +N tile that opens the rest", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({
    parts: Array.from({ length: 5 }, () => ({ type: "image", mimeType: "image/png", url: dot })),
  });
  const grid = await within(feed).findByRole("list", { name: "5 images" });
  expect(within(grid).getAllByRole("img")).toHaveLength(3);
  await user.click(within(grid).getByRole("button", { name: "Show 2 more images" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("4 of 5")).toBeTruthy();
});

test("the lightbox steps through the message's images and gives focus back on Escape", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({
    attachments: [home],
    parts: [{ type: "image", mimeType: "image/png", url: dot }],
  });
  const thumbnail = await within(feed).findByRole("button", { name: "home.png" });
  await user.click(thumbnail);
  const dialog = await screen.findByRole("dialog", { name: "home.png" });
  expect(within(dialog).getByText("479 B · 1 of 2")).toBeTruthy();
  const download = await within(dialog).findByRole("link", { name: "Download" });
  expect(download.getAttribute("download")).toBe("home.png");
  expect(objectUrls.get(download.getAttribute("href") ?? "")?.size).toBe(fixtureBytes);
  expect(within(dialog).getByRole("button", { name: "Copy image" })).toBeTruthy();

  await user.keyboard("{ArrowRight}");
  expect(await screen.findByRole("dialog", { name: "Attached image" })).toBeTruthy();
  expect(screen.getByText("2 of 2")).toBeTruthy();
  await user.keyboard("{ArrowRight}");
  expect(await screen.findByRole("dialog", { name: "home.png" })).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(thumbnail);
});

test("a file the agent saved is named relative to the project, and its image reads as unavailable", async () => {
  const { feed } = await openMessage({}, [
    {
      type: "item.upsert",
      agent: "root",
      item: "shot",
      draft: {
        type: "artifact",
        source: "browser",
        path: "/work/shop/.ace/screens/checkout.png",
        mimeType: "image/png",
        bytes: 4096,
        complete: true,
      },
    },
  ]);
  expect(
    await within(feed).findByRole("img", {
      name: ".ace/screens/checkout.png: image unavailable on this device",
    }),
  ).toBeTruthy();
  expect(within(feed).getByText("Saved").parentElement?.textContent).toBe(
    "Saved.ace/screens/checkout.png",
  );
  expect(feed.textContent).not.toContain("/work/shop");
});

import { facts, fixtureImage } from "@ace/fake-daemon";
import type { Attachment, ContentPart, MessageOrigin } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * The person's message in the transcript: attachments above an unframed bubble (image groups by
 * count, compact file chips that fold past six), long text that folds, code in monospace, and
 * the eyebrow that says a message was steered or queued.
 */

const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  let next = 0;
  URL.createObjectURL = () => `blob:test/${++next}`;
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

const dot =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=";
const images = (count: number): ContentPart[] =>
  Array.from({ length: count }, () => ({ type: "image", mimeType: "image/png", url: dot }));

async function openMessage(draft: {
  text?: string;
  parts?: ContentPart[];
  attachments?: Attachment[];
  origin?: MessageOrigin;
}) {
  const app = harness();
  app.daemon.createThread({
    id: "thread-bubble",
    workspaceId: "shop",
    title: "Bubble",
    provider: "codex",
    details: { worktree: "/work/shop" },
  });
  app.daemon.seedServices({ attachmentImages: [{ threadId: "thread-bubble", name: "home.png" }] });
  app.daemon.apply("thread-bubble", [
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
        parts: [
          ...(draft.text === undefined ? [] : [{ type: "text" as const, text: draft.text }]),
          ...(draft.parts ?? []),
        ],
        ...(draft.attachments ? { attachments: draft.attachments } : {}),
        ...(draft.origin ? { origin: draft.origin } : {}),
      },
    },
    facts.message("root", "reply", "assistant", "Done."),
    facts.endTurn("root"),
  ]);
  await app.open("/t/thread-bubble");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Done.");
  return { feed };
}

const tileSizes = (list: HTMLElement) =>
  within(list)
    .getAllByRole("button")
    .map((tile) => `${tile.style.width}×${tile.style.height}`);

test("one image keeps its shape; two are squares side by side", async () => {
  const single = await openMessage({ text: "One", parts: images(1) });
  const one = await within(single.feed).findByRole("list", { name: "Image" });
  await waitFor(() => expect(tileSizes(one)).toEqual(["320px×240px"]));
});

test("two images are two 160px squares", async () => {
  const { feed } = await openMessage({ text: "Two", parts: images(2) });
  const pair = await within(feed).findByRole("list", { name: "2 images" });
  await waitFor(() => expect(tileSizes(pair)).toEqual(["160px×160px", "160px×160px"]));
});

test("three images are a tall tile on the left beside two stacked squares", async () => {
  const { feed } = await openMessage({ text: "Three", parts: images(3) });
  const trio = await within(feed).findByRole("list", { name: "3 images" });
  await waitFor(() =>
    expect(tileSizes(trio)).toEqual(["160px×324px", "160px×160px", "160px×160px"]),
  );
});

test("five images show four tiles, the last dimmed under +2, opening the fourth image", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({ text: "Five", parts: images(5) });
  const grid = await within(feed).findByRole("list", { name: "5 images" });
  await waitFor(() => expect(within(grid).getAllByRole("button")).toHaveLength(4));
  await user.click(within(grid).getByRole("button", { name: "Show 2 more images" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("4 of 5")).toBeTruthy();
});

test("files past six fold behind a +N files chip that shows the rest", async () => {
  const user = userEvent.setup();
  const attachments: Attachment[] = Array.from({ length: 9 }, (_, index) => ({
    sha256: String(index).repeat(64),
    bytes: 1_000 * (index + 1),
    mimeType: "text/plain",
    name: `notes-${index + 1}.md`,
  }));
  const { feed } = await openMessage({ text: "Files", attachments });
  const files = await within(feed).findByRole("list", { name: "Attached files" });
  expect(within(files).getAllByRole("listitem")).toHaveLength(7);
  expect(within(files).queryByText("notes-7.md")).toBeNull();
  await user.click(within(files).getByRole("button", { name: "+3 files" }));
  expect(within(files).getByText("notes-9.md")).toBeTruthy();
  expect(within(files).queryByRole("button", { name: "+3 files" })).toBeNull();
});

test("a long message folds to its first lines and Show more / Show less toggle it by keyboard", async () => {
  const user = userEvent.setup();
  const text = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n");
  const { feed } = await openMessage({ text });
  const more = await within(feed).findByRole("button", { name: "Show more" });
  const body = document.getElementById(more.getAttribute("aria-controls") ?? "");
  expect(body?.hasAttribute("data-folded")).toBe(true);
  expect(more.getAttribute("aria-expanded")).toBe("false");
  more.focus();
  await user.keyboard("{Enter}");
  const less = within(feed).getByRole("button", { name: "Show less" });
  expect(less.getAttribute("aria-expanded")).toBe("true");
  expect(body?.hasAttribute("data-folded")).toBe(false);
  await user.keyboard("{Enter}");
  expect(within(feed).getByRole("button", { name: "Show more" })).toBeTruthy();
  expect(body?.hasAttribute("data-folded")).toBe(true);
});

test("a short message has nothing to fold", async () => {
  const { feed } = await openMessage({ text: "Short and sweet" });
  expect(within(feed).getByText("Short and sweet")).toBeTruthy();
  expect(within(feed).queryByRole("button", { name: "Show more" })).toBeNull();
});

test("a fenced block inside the message reads as code", async () => {
  const { feed } = await openMessage({
    text: "Why does this fail?\n```ts\nconst total = sum(items);\n```",
  });
  const code = await within(feed).findByText("const total = sum(items);");
  expect(code.tagName).toBe("CODE");
  expect(within(feed).getByText("Why does this fail?").tagName).not.toBe("CODE");
});

test("a message steered into the running turn says Steer above its bubble", async () => {
  const { feed } = await openMessage({ text: "Use the cache instead", origin: { kind: "steer" } });
  expect(within(feed).getByText("Steer")).toBeTruthy();
});

test("a message sent from the queue says Queued; a plain one carries no eyebrow", async () => {
  const queued = await openMessage({ text: "After that, tidy up", origin: { kind: "queue" } });
  expect(within(queued.feed).getByText("Queued")).toBeTruthy();
  expect(within(queued.feed).queryByText("Steer")).toBeNull();
});

test("a typed message has no eyebrow", async () => {
  const { feed } = await openMessage({ text: "Plain words", origin: { kind: "person" } });
  expect(within(feed).queryByText("Steer")).toBeNull();
  expect(within(feed).queryByText("Queued")).toBeNull();
});

test("images sent as files say so in their tooltip, not as words under them", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({
    text: "Look",
    attachments: [
      {
        sha256: fixtureImage.sha256,
        bytes: atob(fixtureImage.data).length,
        mimeType: "image/png",
        name: "home.png",
        width: 120,
        height: 80,
        thumbnailAvailable: true,
        delivery: "file_path",
      },
    ],
  });
  const tile = await within(feed).findByRole("button", { name: "home.png" });
  expect(within(feed).queryByText("Images sent as files")).toBeNull();
  await user.hover(tile);
  expect((await screen.findByRole("tooltip")).textContent).toContain("path");
});

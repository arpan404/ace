import { ClientProvider } from "@ace/client-react";
import { fixtureImage, longHistory } from "@ace/fake-daemon";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { createHash } from "node:crypto";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { AttachmentChips, useAttachments } from "./composer/attachments.tsx";

/*
 * The composer's attachment chips (AT-2): an image's preview at once, upload progress, failures
 * in words with Retry, files the thread's agent can't read (QA-07), and the files a send can
 * wait for.
 */

const objectUrls = new Map<string, Blob>();
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  localStorage.clear();
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

const png = Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0));
const screenshot = () => new File([png], "screen.png", { type: "image/png" });
const thread = { id: "thread-router", workspaceId: "docs-site", title: "Document the router" };

async function openComposer() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, feed, message };
}

test("an image chip shows its preview at once, and the sent message shows the image", async () => {
  const user = userEvent.setup();
  const { feed, message } = await openComposer();
  await user.upload(screen.getByLabelText("Files to attach"), screenshot());
  const chips = await screen.findByRole("list", { name: "Attachments" });
  const preview = chips.querySelector("img");
  const previewed = objectUrls.get(preview?.getAttribute("src") ?? "");
  expect(previewed instanceof File ? previewed.name : undefined).toBe("screen.png");
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());

  await user.type(message, "What is this?{Enter}");
  const sent = await within(feed).findByRole("img", { name: "screen.png" });
  expect(objectUrls.get(sent.getAttribute("src") ?? "")?.size).toBe(png.length);
});

test("a file over the limit says so in words and can only be removed", async () => {
  const user = userEvent.setup();
  await openComposer();
  const big = new File(["x"], "capture.mov", { type: "video/quicktime" });
  Object.defineProperty(big, "size", { value: 600 * 1024 * 1024 });
  await user.upload(screen.getByLabelText("Files to attach"), big);
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(
    within(chips).getByText(
      (_, element) =>
        element?.textContent === "Couldn't upload: Too large: 629 MB, the limit is 537 MB",
    ),
  ).toBeTruthy();
  expect(within(chips).queryByRole("button", { name: "Retry capture.mov" })).toBeNull();
  await user.click(within(chips).getByRole("button", { name: "Remove capture.mov" }));
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});

// The composer's wiring: the hook's chips, with Retry and Remove.
function Chips() {
  const attachments = useAttachments(thread);
  return (
    <>
      <button type="button" onClick={() => attachments.add([screenshot()])}>
        Attach
      </button>
      <AttachmentChips
        items={attachments.items}
        onRemove={attachments.remove}
        onRetry={attachments.retry}
      />
    </>
  );
}

test("a failed upload offers Retry, which uploads the same file again", async () => {
  const user = userEvent.setup();
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.client.start();
  render(
    <ClientProvider client={app.client}>
      <Chips />
    </ClientProvider>,
  );
  app.daemon.failRequests("context.request");
  await user.click(screen.getByRole("button", { name: "Attach" }));
  const chips = await screen.findByRole("list", { name: "Attachments" });
  const retry = await within(chips).findByRole("button", { name: "Retry screen.png" });
  expect(within(chips).getByText(/Couldn't upload/)).toBeTruthy();

  app.daemon.restoreRequests();
  await user.click(retry);
  await waitFor(() => expect(within(chips).queryByText(/Couldn't upload/)).toBeNull());
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
});

test.each([
  ["notes.pdf", "application/pdf", "%PDF-1.7\nexample"],
  ["code.ts", "text/typescript", "export const value = 42;"],
  ["archive.zip", "application/zip", "PK\u0003\u0004example"],
])("%s shows a chip and reaches the fake daemon", async (name, mimeType, data) => {
  const user = userEvent.setup();
  const { app, feed, message } = await openComposer();
  await user.upload(
    screen.getByLabelText("Files to attach"),
    new File([data], name, { type: mimeType }),
  );
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(within(chips).getByText(name)).toBeTruthy();
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(within(chips).queryByText(/Can't be read/)).toBeNull();
  await user.type(message, `Read ${name}{Enter}`);
  const sentFiles = await within(feed).findByRole("list", { name: "Attached files" });
  expect(within(sentFiles).getByText(new RegExp(name.replace(".", "\\.")))).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  if (!view || !("items" in view)) throw new Error("Missing thread transcript");
  const sent = Object.values(view.items).find(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.attachments?.some((file) => file.name === name),
  );
  expect(sent).toMatchObject({
    attachments: [
      expect.objectContaining({ name, sha256: createHash("sha256").update(data).digest("hex") }),
    ],
  });
});

test("a provider without native images still accepts image files", async () => {
  const user = userEvent.setup();
  const app = harness();
  app.daemon.createThread({
    id: "thread-no-images",
    workspaceId: "docs-site",
    title: "Text-only agent",
    provider: "codex",
    capabilities: { imageInput: false },
  });
  await app.open("/t/thread-no-images");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await user.click(screen.getByRole("button", { name: "Add files and context" }));
  const images = await screen.findByRole("menuitem", { name: /Images/ });
  expect(images.getAttribute("aria-disabled")).toBeNull();
  await user.keyboard("{Escape}");

  await user.type(message, "Describe it");
  await user.upload(screen.getByLabelText("Files to attach"), screenshot());
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(within(chips).queryByText(/Can't be read/)).toBeNull();
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBeNull();
});

test("an upload in progress shows a ring with its percentage", async () => {
  render(
    <AttachmentChips
      items={[{ key: 1, name: "screen.png", state: "uploading", progress: 0.42 }]}
      onRemove={() => {}}
    />,
  );
  const ring = await screen.findByRole("progressbar", { name: "Uploading screen.png" });
  expect(ring.getAttribute("aria-valuenow")).toBe("42");
});

async function hookAgainstDaemon() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.client.start();
  const wrapper = (props: { children: ReactNode }) => (
    <ClientProvider client={app.client}>{props.children}</ClientProvider>
  );
  return renderHook(() => useAttachments(thread), { wrapper });
}

test("settled() waits for running uploads and keeps them after the chips are cleared", async () => {
  const { result } = await hookAgainstDaemon();
  act(() => result.current.add([screenshot()]));
  expect(result.current.uploading).toBe(true);
  const settled = result.current.settled();
  act(() => result.current.clear());
  expect(await settled).toEqual([
    { sha256: createHash("sha256").update(png).digest("hex"), name: "screen.png" },
  ]);
});

test("a handed-off message keeps its image previews until it releases them", async () => {
  const { result } = await hookAgainstDaemon();
  act(() => result.current.add([screenshot()]));
  let handed: ReturnType<typeof result.current.handOff> | undefined;
  act(() => {
    handed = result.current.handOff();
  });
  expect(result.current.items).toEqual([]);
  const previewUrl = handed?.local[0]?.previewUrl ?? "";
  expect(handed?.local).toEqual([
    { name: "screen.png", mimeType: "image/png", bytes: png.length, previewUrl },
  ]);
  expect(objectUrls.has(previewUrl)).toBe(true);
  expect(await handed?.settled).toHaveLength(1);
  handed?.release();
  expect(objectUrls.has(previewUrl)).toBe(false);
});

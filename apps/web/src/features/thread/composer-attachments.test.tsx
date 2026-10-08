import { ClientProvider } from "@ace/client-react";
import { fixtureImage, longHistory } from "@ace/fake-daemon";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { createHash } from "node:crypto";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { harness } from "@/test/harness.tsx";
import { AttachmentChips, useAttachments } from "./composer/attachments.tsx";

/*
 * The composer's attachment chips (AT-2): an image's preview at once, each file's kind in
 * words, upload progress, failures in words with Retry, the keyboard, the size and duplicate
 * checks before uploading, and the files a send can wait for.
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
        element?.textContent === "Couldn't upload: Too large: files can be up to 512 MB each",
    ),
  ).toBeTruthy();
  expect(within(chips).queryByRole("button", { name: "Retry capture.mov" })).toBeNull();
  await user.click(within(chips).getByRole("button", { name: "Remove capture.mov" }));
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});

/** A file whose size is claimed rather than held, for the limits checked before uploading. */
function sized(name: string, megabytes: number): File {
  const file = new File(["x"], name, { type: "video/quicktime" });
  Object.defineProperty(file, "size", { value: megabytes * 1024 * 1024 });
  return file;
}

test("each chip names its file's kind and size, and Delete removes it, focus moving on", async () => {
  const user = userEvent.setup();
  const { message } = await openComposer();
  const files = [
    new File(["%PDF-1.7"], "spec.pdf", { type: "application/pdf" }),
    new File(["export {};"], "router.ts", { type: "" }),
    new File(["a,b\n1,2"], "totals.csv", { type: "text/csv" }),
    new File(["PK\u0003\u0004"], "bundle.zip", { type: "application/zip" }),
    new File(["ID3"], "memo.mp3", { type: "audio/mpeg" }),
    new File(["\u0000\u0001"], "core.bin", { type: "application/octet-stream" }),
  ];
  await user.upload(screen.getByLabelText("Files to attach"), files);
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  const meta = (name: string) =>
    within(chips).getByRole("button", { name: `Preview ${name}` }).lastElementChild?.textContent;
  expect(meta("spec.pdf")).toBe("8 B · PDF");
  expect(meta("router.ts")).toBe("10 B · TypeScript");
  expect(meta("totals.csv")).toBe("7 B · CSV");
  expect(meta("bundle.zip")).toBe("4 B · ZIP archive");
  expect(meta("memo.mp3")).toBe("3 B · MP3");
  expect(meta("core.bin")).toBe("2 B · BIN");

  within(chips).getByRole("button", { name: "Preview totals.csv" }).focus();
  await user.keyboard("{Delete}");
  expect(within(chips).queryByRole("button", { name: "Preview totals.csv" })).toBeNull();
  expect(document.activeElement).toBe(
    within(chips).getByRole("button", { name: "Preview bundle.zip" }),
  );
  await user.keyboard("{Backspace}");
  expect(document.activeElement).toBe(
    within(chips).getByRole("button", { name: "Preview memo.mp3" }),
  );

  // The last chip gone, the caret goes back to the message.
  for (const name of ["memo.mp3", "core.bin", "spec.pdf", "router.ts"]) {
    within(chips)
      .getByRole("button", { name: `Preview ${name}` })
      .focus();
    await user.keyboard("{Delete}");
  }
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  expect(document.activeElement).toBe(message);
});

test("a long attachment name can be read in full in its preview", async () => {
  const user = userEvent.setup();
  await openComposer();
  const name = "quarterly-infrastructure-cost-review-final-v3.xlsx";
  await user.upload(screen.getByLabelText("Files to attach"), new File(["x"], name));
  const chip = await screen.findByRole("button", { name: `Preview ${name}` });
  expect(chip.textContent).toContain(name);
  await user.click(chip);
  const preview = await screen.findByRole("dialog", { name });
  expect(within(preview).getByRole("heading", { name }).textContent).toBe(name);
});

test("files adding up past the message limit are refused before uploading, naming the limit", async () => {
  const user = userEvent.setup();
  await openComposer();
  await user.upload(screen.getByLabelText("Files to attach"), [
    sized("one.mov", 300),
    sized("two.mov", 300),
    sized("three.mov", 300),
    sized("four.mov", 300),
  ]);
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(
    within(chips).getByText(
      (_, element) =>
        element?.textContent ===
        "Couldn't upload: Too much for one message: files can add up to 1 GB",
    ),
  ).toBeTruthy();
  expect(within(chips).queryByRole("button", { name: "Retry four.mov" })).toBeNull();
  // Only the file that tipped the total over is refused for it.
  expect(within(chips).getAllByText(/Too much for one message/)).toHaveLength(1);
});

test("the same file added twice shows one chip and goes once", async () => {
  const user = userEvent.setup();
  const { app, feed, message } = await openComposer();
  const input = screen.getByLabelText("Files to attach");
  // Picked twice: the same file, so it is skipped at once.
  const notes = new File(["QA_TOKEN 42"], "notes.txt", { type: "text/plain", lastModified: 5 });
  await user.upload(input, notes);
  await user.upload(input, notes);
  // A copy with the same name and bytes but another date: one chip once both are hashed.
  await user.upload(
    input,
    new File(["QA_TOKEN 42"], "notes.txt", { type: "text/plain", lastModified: 9 }),
  );
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  await waitFor(() =>
    expect(within(chips).getAllByRole("button", { name: "Preview notes.txt" })).toHaveLength(1),
  );

  await user.type(message, "Read it{Enter}");
  await within(feed).findByRole("list", { name: "Attached files" });
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
  if (!view || !("items" in view)) throw new Error("Missing thread transcript");
  const sent = Object.values(view.items).find(
    (item) => item.type === "message" && item.role === "user" && item.attachments?.length,
  );
  expect(sent?.type === "message" ? sent.attachments?.map((file) => file.name) : []).toEqual([
    "notes.txt",
  ]);
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
      <ToastProvider>
        <Chips />
      </ToastProvider>
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
])("%s shows a chip and reaches the fake ace", async (name, mimeType, data) => {
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
    <ClientProvider client={app.client}>
      <ToastProvider>{props.children}</ToastProvider>
    </ClientProvider>
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

test("removing a ready chip releases its thread attachment", async () => {
  const { app } = await openComposer();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["draft"], "notes.txt", { type: "text/plain" }),
  );
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  await userEvent.click(within(chips).getByRole("button", { name: "Remove notes.txt" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
  const reply = await app.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: ThreadId.parse(thread.id) },
  });
  expect(reply.result).toMatchObject({ kind: "attachments", attachments: [] });
});

test("the Attachments sheet lists kept files and removal clears a ready chip and its reference", async () => {
  const { app } = await openComposer();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["draft"], "notes.txt", { type: "text/plain" }),
  );
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Attachments" }));
  const sheet = await screen.findByRole("dialog", { name: "Attachments" });
  expect(await within(sheet).findByText("1 of 256 attachments")).toBeTruthy();
  await userEvent.click(within(sheet).getByRole("button", { name: "Remove notes.txt" }));
  expect(await within(sheet).findByText("No attachments in this thread.")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
  const reply = await app.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: ThreadId.parse(thread.id) },
  });
  expect(reply.result).toMatchObject({ kind: "attachments", attachments: [] });
});

test("removing a chip before upload completion releases the eventual attachment", async () => {
  const { app } = await openComposer();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    committed = Promise.withResolvers<void>();
  const file = new File(["pending draft"], "pending.txt", { type: "text/plain" });
  const slice = file.slice.bind(file);
  file.slice = (start, end, type) => {
    const part = slice(start, end, type),
      read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => {
      entered.resolve();
      await release.promise;
      return read();
    };
    return part;
  };
  const unsubscribe = app.client.onMessage((message) => {
    if (
      message.type === "context.result" &&
      message.result.kind === "attachment" &&
      message.result.attachment.name === "pending.txt"
    )
      committed.resolve();
  });
  try {
    await userEvent.upload(screen.getByLabelText("Files to attach"), file);
    await entered.promise;
    const chips = await screen.findByRole("list", { name: "Attachments" });
    await userEvent.click(within(chips).getByRole("button", { name: "Remove pending.txt" }));
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    release.resolve();
    await committed.promise;
    await waitFor(async () => {
      const reply = await app.client.request({
        type: "context.request",
        operation: { op: "attachment.list", threadId: ThreadId.parse(thread.id) },
      });
      expect(reply.result).toMatchObject({ kind: "attachments", attachments: [] });
    });
  } finally {
    release.resolve();
    unsubscribe();
  }
});

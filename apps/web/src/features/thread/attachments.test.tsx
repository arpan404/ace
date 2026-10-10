import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import type { Attachment, ContentPart } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  vi.restoreAllMocks();
});

const fixtureBytes = atob(fixtureImage.data).length;
const dot =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=";

/** A settled thread whose one user message carries `draft`'s parts and attachments. */
async function openMessage(
  draft: { parts?: ContentPart[]; attachments?: Attachment[] },
  extra: Parameters<FakeDaemon["apply"]>[1] = [],
  readyText = "What changed here?",
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
  await within(feed).findByText(readyText);
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

test("a native image captured after the answer arrives appears inline from its owning environment", async () => {
  const { app, feed } = await openMessage({}, [
    facts.rootAgent("codex", "/remote/results"),
    facts.tool("root", "native-image", {
      kind: "image",
      title: "Viewed image",
      detail: { kind: "image", path: "/remote/results/home.png" },
    }),
    facts.toolDone("root", "native-image"),
    facts.message(
      "root",
      "answer",
      "assistant",
      "Here is ![Remote result](./home.png) in the chat.",
    ),
  ]);
  await within(feed).findByText(/in the chat/);
  expect(within(feed).queryByRole("img", { name: "Remote result" })).toBeNull();
  act(() =>
    app.daemon.apply("thread-shots", [
      {
        type: "item.upsert",
        agent: "root",
        item: "native-image",
        draft: {
          type: "tool_call",
          complete: true,
          call: { detail: { kind: "image", path: "/remote/results/home.png", attachment: home } },
        },
      },
    ]),
  );
  const image = await within(feed).findByRole("img", { name: "Remote result" });
  expect(objectUrls.get(image.getAttribute("src") ?? "")?.size).toBe(fixtureBytes);
  expect(image.closest("p")?.textContent).toContain("in the chat.");
  expect(image.closest("p")?.querySelector("div")).toBeNull();
});

test("source links open the thread checkout while unrelated host paths remain unavailable", async () => {
  const { feed } = await openMessage({}, [
    facts.message(
      "root",
      "answer",
      "assistant",
      "Read [source](/work/shop/src/main.ts:12) and [other](/remote/other/main.ts).",
    ),
  ]);
  await userEvent.click(await within(feed).findByRole("button", { name: "source" }));
  await screen.findByRole("tab", { name: /main.ts/ });
  expect(within(feed).queryByRole("button", { name: "other" })).toBeNull();
  expect(within(feed).getByText("other").getAttribute("title")).toContain("not available");
});

test("an older relative image stays visible after its agent changes folders", async () => {
  const { app, feed } = await openMessage({}, [
    facts.tool("root", "old-chart", {
      kind: "image",
      title: "Viewed image",
      detail: {
        kind: "image",
        path: "/work/shop/home.png",
        sourcePath: "home.png",
        attachment: home,
      },
    }),
    facts.toolDone("root", "old-chart"),
    facts.message("root", "old-answer", "assistant", "![Original chart](./home.png)"),
  ]);
  const image = await within(feed).findByRole("img", { name: "Original chart" });
  const first = image.getAttribute("src");
  act(() => app.daemon.apply("thread-shots", [facts.rootAgent("codex", "/remote/new-folder")]));
  await waitFor(() =>
    expect(within(feed).getByRole("img", { name: "Original chart" }).getAttribute("src")).toBe(
      first,
    ),
  );
});

test("a relative image uses the answering agent's capture rather than a child's same filename", async () => {
  const { feed } = await openMessage({}, [
    facts.tool("root", "root-chart", {
      kind: "image",
      title: "Viewed image",
      detail: {
        kind: "image",
        path: "/work/shop/home.png",
        sourcePath: "home.png",
        attachment: home,
      },
    }),
    facts.toolDone("root", "root-chart"),
    {
      type: "agent.seen",
      agent: "child",
      parent: "root",
      spawnedBy: "root-chart",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "codex", nativeId: "child" },
      cwd: "/work/shop",
    },
    facts.tool("child", "child-chart", {
      kind: "image",
      title: "Viewed image",
      detail: {
        kind: "image",
        path: "/work/shop/home.png",
        attachment: { ...home, sha256: "e".repeat(64) },
      },
    }),
    facts.toolDone("child", "child-chart"),
    facts.message("root", "root-answer", "assistant", "![Root chart](./home.png)"),
  ]);
  const image = await within(feed).findByRole("img", { name: "Root chart" });
  expect(objectUrls.get(image.getAttribute("src") ?? "")?.size).toBe(fixtureBytes);
});

test("a delayed capture outside the loaded transcript refreshes the answer's image metadata", async () => {
  const old = [
    facts.tool("root", "evicted-chart", {
      kind: "image",
      title: "Viewed image",
      detail: { kind: "image", path: "/work/shop/home.png", sourcePath: "home.png" },
    }),
    facts.toolDone("root", "evicted-chart"),
    ...Array.from({ length: 205 }, (_, index) =>
      facts.message("root", `older-${index}`, "assistant", `Older message ${index}`),
    ),
    facts.message("root", "latest-chart", "assistant", "![Delayed chart](./home.png)"),
  ];
  const { app, feed } = await openMessage({}, old, "Delayed chart");
  await within(feed).findByText("Delayed chart");
  act(() =>
    app.daemon.apply("thread-shots", [
      {
        type: "item.upsert",
        agent: "root",
        item: "evicted-chart",
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            detail: {
              kind: "image",
              path: "/work/shop/home.png",
              sourcePath: "home.png",
              attachment: home,
            },
          },
        },
      },
    ]),
  );
  const image = await within(feed).findByRole("img", { name: "Delayed chart" }, { timeout: 3000 });
  expect(objectUrls.get(image.getAttribute("src") ?? "")?.size).toBe(fixtureBytes);
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
  expect(within(files).getByText("plan.md")).toBeTruthy();
  expect(within(files).queryByRole("button", { name: "plan.md, Markdown" })).toBeNull();
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

  // Base UI schedules initial focus after mounting; keyboard events need that focus target.
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  await user.keyboard("{ArrowRight}");
  expect(await screen.findByRole("dialog", { name: "Attached image" })).toBeTruthy();
  expect(screen.getByText("2 of 2")).toBeTruthy();
  await user.keyboard("{ArrowRight}");
  expect(await screen.findByRole("dialog", { name: "home.png" })).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(thumbnail));
});

test("a saved artifact opens its checkout file and downloads the original bytes", async () => {
  const user = userEvent.setup();
  const downloads: { name: string; blob: Blob | undefined }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, blob: objectUrls.get(this.href) });
  });
  const { feed } = await openMessage({}, [
    {
      type: "item.upsert",
      agent: "root",
      item: "saved",
      draft: {
        type: "artifact",
        source: "browser",
        path: "/work/shop/src/index.ts",
        mimeType: "text/plain",
        bytes: 32,
        complete: true,
      },
    },
  ]);
  await user.click(await within(feed).findByRole("button", { name: "Download saved file" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0]?.name).toBe("index.ts");
  expect(await downloads[0]?.blob?.text()).toContain('export { App } from "./app.tsx"');
  await waitFor(() =>
    expect(
      within(feed).getByRole("button", { name: "Download saved file" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  await user.click(within(feed).getByRole("button", { name: "Open saved file" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const source = await within(panel).findByRole("region", { name: "Source of src/index.ts" });
  await waitFor(() => expect(source.textContent).toContain('export { App } from "./app.tsx"'));
  expect(within(panel).getByRole("tab", { name: "index.ts" })).toBeTruthy();
  expect(within(feed).getByText("src/index.ts")).toBeTruthy();
  expect(feed.textContent).not.toContain("/work/shop");
  await user.click(within(panel).getByRole("button", { name: "Edit file" }));
  const draft = await within(panel).findByRole("textbox", { name: "Edit src/index.ts" });
  await user.type(draft, "\n// Unsaved note");
  await user.click(within(feed).getByRole("button", { name: "Open saved file" }));
  expect(
    (within(panel).getByRole("textbox", { name: "Edit src/index.ts" }) as HTMLTextAreaElement)
      .value,
  ).toContain("// Unsaved note");
});

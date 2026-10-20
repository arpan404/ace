import { Client, type ClientApi, type RequestOptions } from "@ace/client";
import { facts, fakeTransport, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import { DeviceId, type Attachment, type ContentPart, type ContextResult } from "@ace/protocol";
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
  client?: (daemon: FakeDaemon) => ClientApi,
) {
  const app = harness(client ? { client } : {});
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
    parts: [{ type: "file", path: `/Users/dev/.ace/context/blobs/${"c".repeat(64)}` }],
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

test("source links open the thread checkout and links outside it download from the host", async () => {
  const { app, feed } = await openMessage({}, [
    facts.message(
      "root",
      "answer",
      "assistant",
      "Read [source](/work/shop/src/main.ts:12) and [the guide](</Users/me/Downloads/Study Guide.pdf>).",
    ),
  ]);
  app.daemon.checkouts.seedLinked(
    "thread-shots",
    app.daemon.itemId("thread-shots", "answer") ?? "",
    "/Users/me/Downloads/Study Guide.pdf",
    "%PDF guide",
  );
  await userEvent.click(await within(feed).findByRole("button", { name: "source" }));
  await screen.findByRole("tab", { name: /main.ts/ });
  const downloads: { name: string; blob: Blob | undefined }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, blob: objectUrls.get(this.href) });
  });
  await userEvent.click(within(feed).getByRole("button", { name: "the guide" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0]?.name).toBe("Study Guide.pdf");
  expect(await downloads[0]?.blob?.text()).toBe("%PDF guide");
});

test("a link outside the checkout that the host can't serve says so", async () => {
  const { feed } = await openMessage({}, [
    facts.message("root", "answer", "assistant", "See [other](/remote/other/main.ts)."),
  ]);
  await userEvent.click(await within(feed).findByRole("button", { name: "other" }));
  expect(await screen.findByRole("heading", { name: "Couldn't open main.ts" })).toBeTruthy();
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
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("48 KB · Log · inline text, truncated");
  expect(tooltip.textContent).toContain(
    "The first 16 KB of text went into the message, with a path to the rest",
  );
});

test("more than four images show a 2×2 grid whose last tile, dimmed, opens the rest", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({
    parts: Array.from({ length: 5 }, () => ({ type: "image", mimeType: "image/png", url: dot })),
  });
  const grid = await within(feed).findByRole("list", { name: "5 images" });
  await waitFor(() => expect(within(grid).getAllByRole("img")).toHaveLength(4));
  expect(within(grid).getByText("+2")).toBeTruthy();
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

test("opening an image moves focus into the viewer and closing returns it to the thumbnail", async () => {
  const user = userEvent.setup();
  const { feed } = await openMessage({ attachments: [home] });
  const thumbnail = await within(feed).findByRole("button", { name: "home.png" });

  // What Chromium blocks: an ancestor taking aria-hidden while it holds the focused thumbnail.
  const hiddenWhileFocused: string[] = [];
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (name === "aria-hidden" && value === "true" && this instanceof HTMLElement) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.contains(active)) {
        hiddenWhileFocused.push(this.className);
      }
    }
    return originalSetAttribute.call(this, name, value);
  };
  try {
    await user.click(thumbnail);
    const dialog = await screen.findByRole("dialog", { name: "home.png" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // While open, the focused element must not sit inside an aria-hidden ancestor.
    let node: HTMLElement | null = document.activeElement as HTMLElement | null;
    while (node) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
      node = node.parentElement;
    }
    expect(hiddenWhileFocused).toEqual([]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(thumbnail));
  } finally {
    Element.prototype.setAttribute = originalSetAttribute;
  }
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

/*
 * The lightbox must show the full-resolution bytes once loaded, not the thumbnail stretched:
 * a retina screenshot looks blurry otherwise. The fake daemon serves the same bytes for both
 * variants, so these tests serve variant-dependent bytes at the request boundary instead.
 */

// Full-resolution bytes the daemon holds for `big`, and its small bounded preview.
const fullBytes = new Uint8Array(3000).fill(7);
const thumbBytes = Uint8Array.from(atob(dot.split(",")[1] ?? ""), (char) => char.charCodeAt(0));

const big: Attachment = {
  sha256: "b".repeat(64),
  bytes: fullBytes.length,
  mimeType: "image/png",
  name: "big.png",
  width: 2900,
  height: 1800,
  thumbnailAvailable: true,
};

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A real client whose attachment reads serve full bytes for originals, preview bytes else. */
function variantClient(daemon: FakeDaemon): ClientApi {
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `variant-${++ids}`,
  });
  const fallback = client.request.bind(client);
  vi.spyOn(client, "request").mockImplementation((input, options?: RequestOptions) => {
    if (input.type === "context.request" && input.operation.op === "attachment.read") {
      const op = input.operation;
      const payload = op.variant === "original" ? fullBytes : thumbBytes;
      const offset = op.offset ?? 0;
      const chunk = payload.subarray(offset, offset + (op.limit ?? 65536));
      return Promise.resolve({
        type: "context.result",
        requestId: "read",
        result: {
          kind: "attachment.data",
          sha256: op.sha256,
          variant: op.variant ?? "thumbnail",
          mimeType: "image/png",
          bytes: payload.length,
          offset,
          data: b64encode(chunk),
          eof: offset + chunk.length === payload.length,
        },
      } satisfies ContextResult);
    }
    return fallback(input, options);
  });
  return client;
}

async function openBig() {
  return openMessage({ attachments: [big] }, [], "What changed here?", variantClient);
}

async function openLightbox(feed: HTMLElement) {
  const user = userEvent.setup();
  await user.click(await within(feed).findByRole("button", { name: "big.png" }));
  return { dialog: await screen.findByRole("dialog", { name: "big.png" }), user };
}

test("the lightbox shows the full-resolution bytes once loaded, not the stretched preview", async () => {
  const { feed } = await openBig();
  // The transcript keeps the cheap preview.
  const tile = await within(feed).findByRole("img", { name: "big.png" });
  expect(objectUrls.get(tile.getAttribute("src") ?? "")?.size).toBe(thumbBytes.length);
  const { dialog } = await openLightbox(feed);
  // The stage swaps to the full bytes once they arrive.
  await waitFor(() => {
    const img = within(dialog).getByRole("img", { name: "big.png" });
    expect(objectUrls.get(img.getAttribute("src") ?? "")?.size).toBe(fullBytes.length);
  });
  // Download saves the full image under its own name.
  const link = within(dialog).getByRole("link", { name: "Download" });
  expect(link.getAttribute("download")).toBe("big.png");
  expect(objectUrls.get(link.getAttribute("href") ?? "")?.size).toBe(fullBytes.length);
});

/** The platform's ClipboardItem, recording what the page hands the clipboard. */
class ClipboardItemStub {
  readonly types: string[];
  private readonly data: Record<string, Blob | Promise<Blob>>;
  constructor(data: Record<string, Blob | Promise<Blob>>) {
    this.data = data;
    this.types = Object.keys(data);
  }
  async getType(type: string): Promise<Blob> {
    const value = this.data[type];
    if (!value) throw new Error(`missing ${type}`);
    return value;
  }
}

/**
 * jsdom has no ClipboardItem and its fetch knows no blob: URLs; stub both boundaries. The
 * clipboard itself comes from user-event's own stub (installed by userEvent.setup()), which
 * the test reads back through navigator.clipboard.read().
 */
async function withBlobFetch(run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("ClipboardItem", ClipboardItemStub);
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (!url.startsWith("blob:")) return realFetch(input as RequestInfo);
    // Hand back the blob itself: a real fetch(blob:) resolves to the same bytes and type.
    const blob = objectUrls.get(url);
    if (!blob) throw new Error("revoked");
    return { blob: async () => blob };
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
  }
}

test("copy image writes the full-resolution PNG to the clipboard", async () => {
  await withBlobFetch(async () => {
    const { feed } = await openBig();
    const { dialog, user } = await openLightbox(feed);
    // The buttons enable once the full image is here.
    await waitFor(() => {
      const img = within(dialog).getByRole("img", { name: "big.png" });
      expect(objectUrls.get(img.getAttribute("src") ?? "")?.size).toBe(fullBytes.length);
    });
    await user.click(await within(dialog).findByRole("button", { name: "Copy image" }));
    const items = await navigator.clipboard.read();
    expect(items).toHaveLength(1);
    expect(items[0]?.types).toEqual(["image/png"]);
    const blob = await items[0]?.getType("image/png");
    expect(blob?.type).toBe("image/png");
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(fullBytes);
  });
});

test("a refused copy says what happened instead of failing silently", async () => {
  await withBlobFetch(async () => {
    const { feed } = await openBig();
    const { dialog, user } = await openLightbox(feed);
    await waitFor(() => {
      const img = within(dialog).getByRole("img", { name: "big.png" });
      expect(objectUrls.get(img.getAttribute("src") ?? "")?.size).toBe(fullBytes.length);
    });
    vi.spyOn(navigator.clipboard, "write").mockRejectedValueOnce(new Error("denied"));
    await user.click(await within(dialog).findByRole("button", { name: "Copy image" }));
    expect(
      await screen.findByRole("alertdialog", { name: "Couldn't copy the image" }),
    ).toBeTruthy();
  });
});

test("download triggers a save of the full image under its own name", async () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  const { feed } = await openBig();
  const { dialog } = await openLightbox(feed);
  within(dialog).getByRole("link", { name: "Download" }).click();
  expect(clicked).toHaveLength(1);
  expect(clicked[0]?.getAttribute("download")).toBe("big.png");
  expect(objectUrls.get(clicked[0]?.getAttribute("href") ?? "")?.size).toBe(fullBytes.length);
});

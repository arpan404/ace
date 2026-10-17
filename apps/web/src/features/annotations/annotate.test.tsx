import { longHistory, seedPanels } from "@ace/fake-daemon";
import { ThreadId, type BrowserAnnotationPageCommand } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { annotateUnavailable } from "./index.ts";

configure({ asyncUtilTimeout: 10000 });

const threadId = "thread-router";

const clipboard: Blob[] = [];
const original = { clipboard: navigator.clipboard, item: globalThis.ClipboardItem };
beforeEach(() => {
  localStorage.clear();
  clipboard.length = 0;
  // jsdom has no clipboard: this stands in for the browser's, at its boundary.
  class Item {
    items: Record<string, Promise<Blob>>;
    constructor(items: Record<string, Promise<Blob>>) {
      this.items = items;
    }
  }
  Object.defineProperty(globalThis, "ClipboardItem", { value: Item, configurable: true });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: Item[]) => {
        for (const item of items) clipboard.push(await (item.items["image/png"] as Promise<Blob>));
      },
    },
  });
});
afterEach(() => {
  Object.defineProperty(globalThis, "ClipboardItem", { value: original.item, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: original.clipboard, configurable: true });
});

async function annotating() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  seedPanels(app.daemon, threadId);
  const view = await app.open(`/t/${threadId}`);
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("tablist", { name: "Browser tabs" });
  const browser = app.daemon.browser;
  // The agent is on a web page of the project's dev server.
  act(() => browser.drive(threadId, { url: "http://localhost:5173/settings/devices" }));
  await waitFor(() =>
    expect(
      within(panel).getByRole("button", { name: "Annotate" }).getAttribute("aria-disabled"),
    ).toBeNull(),
  );
  // The fixture's captures are one image; each capture here gets its own bytes, as a real
  // page's crops and screenshots would, so the message's images stay apart.
  const commands: BrowserAnnotationPageCommand[] = [];
  const execute = browser.annotations.execute.bind(browser.annotations);
  let captures = 0;
  browser.annotations.execute = (thread, connection, command) => {
    if (command.action === "annotate" && command.operation === "command")
      commands.push(command.command);
    const result = execute(thread, connection, command);
    if (command.action !== "annotate_capture" || typeof result !== "object" || !result)
      return result;
    const capture = result as { data: string };
    return { ...capture, data: btoa(atob(capture.data) + String(++captures).padStart(4, "0")) };
  };
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, view, panel, browser, commands, message };
}

const annotateButton = (panel: HTMLElement) =>
  within(panel).getByRole("button", { name: "Annotate" });

function userMessages(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  if (!view || !("items" in view)) throw new Error("Missing transcript");
  return Object.values(view.items).flatMap((item) =>
    item.type === "message" && item.role === "user" ? [item] : [],
  );
}

test("pinned comments join the draft with their crops, and the page's Send sends the person's words, the annotation block and the images last", async () => {
  const { app, panel, browser, message } = await annotating();
  const before = userMessages(app).length;
  await userEvent.type(message, "Tighten the pairing screen");

  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  // Annotating takes nothing from the agent: it keeps working in the tab.
  expect(browser.tab(threadId)?.inUse).toMatchObject({ kind: "agent" });
  expect(annotateButton(panel).getAttribute("aria-pressed")).toBe("true");

  act(
    () =>
      void browser.annotations.pin(threadId, {
        comment: "Make this bolder",
        tag: "h1",
        text: "Pair a device",
      }),
  );
  await screen.findByRole("button", { name: "Show 1 annotation" });
  act(
    () =>
      void browser.annotations.pin(threadId, {
        comment: "Too much padding",
        tag: "button",
        text: "Pair",
      }),
  );
  await screen.findByRole("button", { name: "Show 2 annotations" });

  act(() => browser.annotations.emit(threadId, { kind: "send" }));
  const sent = await waitFor(() => {
    const [latest] = userMessages(app).slice(before);
    if (!latest?.attachments?.length) throw new Error("not sent yet");
    return latest;
  });
  const [words, block] = sent.parts;
  expect(words).toEqual({ type: "text", text: "Tighten the pairing screen" });
  if (block?.type !== "text") throw new Error("no annotation block");
  expect(block.text).toContain('<browser_annotations version="1" count="2">');
  expect(block.text).toContain('[1] <h1> "Pair a device"');
  expect(block.text).toContain("Comment: Too much padding");
  expect(block.text).toContain("Images: the last 3 images of this message, in order:");
  expect(sent.attachments?.map((file) => file.name)).toEqual([
    "annotated-page-1.png",
    "annotation-1.png",
    "annotation-2.png",
  ]);

  // Sending leaves annotate mode and empties the composer.
  await waitFor(() => expect(browser.view(threadId)?.annotation).toBeUndefined());
  expect(screen.queryByRole("button", { name: /^Show \d+ annotation/ })).toBeNull();
  expect(message.textContent).toBe("");

  // The transcript shows the person's words and folds the annotations into a card.
  const feed = screen.getByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByText("2 annotations");
  expect(within(feed).queryByText(/browser_annotations/)).toBeNull();
  await userEvent.click(card);
  expect(within(feed).getByText("Make this bolder")).toBeTruthy();
  expect(within(feed).getByText("Too much padding")).toBeTruthy();
});

test("the chip's list removes one annotation from the draft and its marker from the page, and the rest close ranks; ✕ removes them all", async () => {
  const { panel, browser, commands } = await annotating();
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  const first = browser.annotations.pin(threadId, { comment: "First note" });
  let second = first;
  act(() => {
    second = browser.annotations.pin(threadId, {
      comment: "Second note",
      styles: [{ property: "color", before: "rgb(0, 0, 0)", after: "rgb(200, 0, 0)" }],
      textChange: { before: "Pair", after: "Pair now" },
    });
  });

  await userEvent.click(await screen.findByRole("button", { name: "Show 2 annotations" }));
  const list = await screen.findByRole("list", { name: "Annotations" });
  expect(within(list).getByText("First note")).toBeTruthy();
  expect(within(list).getByText("1 style change · text changed")).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: "Remove annotation 1" }));
  await screen.findByRole("button", { name: "Show 1 annotation" });
  await waitFor(() => expect(commands).toContainEqual({ op: "remove", id: first.id }));
  // The second note is now the first, in the draft and on the page.
  expect(within(list).getByRole("button", { name: "Remove annotation 1" })).toBeTruthy();
  await waitFor(() =>
    expect(commands).toContainEqual({ op: "renumber", numbers: [{ id: second.id, number: 1 }] }),
  );
  expect(commands).toContainEqual(expect.objectContaining({ op: "configure", nextNumber: 2 }));

  await userEvent.click(screen.getByRole("button", { name: "Remove all annotations" }));
  expect(screen.queryByRole("button", { name: /^Show \d+ annotation/ })).toBeNull();
  await waitFor(() => expect(commands).toContainEqual({ op: "clear" }));
});

test("the bar's screenshot copies the page with its markers and says so on the page", async () => {
  const { panel, browser, commands } = await annotating();
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  act(() => browser.annotations.emit(threadId, { kind: "screenshot" }));
  await waitFor(() =>
    expect(commands).toContainEqual({ op: "toast", text: "Screenshot saved to clipboard" }),
  );
  expect(clipboard[0]?.type).toBe("image/png");
});

test("closing annotate mode from the page ends it and keeps the annotations in the draft", async () => {
  const { panel, browser } = await annotating();
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  act(() => void browser.annotations.pin(threadId, { comment: "Keep me" }));
  await screen.findByRole("button", { name: "Show 1 annotation" });

  act(() => browser.annotations.emit(threadId, { kind: "close" }));
  await waitFor(() => expect(browser.view(threadId)?.annotation).toBeUndefined());
  await waitFor(() => expect(annotateButton(panel).getAttribute("aria-pressed")).toBe("false"));
  expect(screen.getByRole("button", { name: "Show 1 annotation" })).toBeTruthy();
});

test("Annotate says why it can't start", () => {
  const driver = {
    start: async () => ({ documentId: "d" }),
    stop: async () => {},
    command: async () => {},
    capture: async () => ({ mimeType: "image/png" as const, data: "", width: 1, height: 1 }),
    events: () => () => {},
  };
  const page = { url: "http://localhost:5173/", closed: false, features: ["annotate"] };
  expect(annotateUnavailable({ driver, online: true, page })).toBeUndefined();
  expect(annotateUnavailable({ driver, online: false, page })).toBe("ace is offline");
  expect(annotateUnavailable({ driver, online: true, page: undefined })).toBe(
    "Open a page to annotate it",
  );
  expect(annotateUnavailable({ driver, online: true, page: { ...page, url: "about:blank" } })).toBe(
    "Only web pages can be annotated",
  );
  expect(annotateUnavailable({ driver, online: true, page: { ...page, status: "paused" } })).toBe(
    "The browser is paused",
  );
  expect(annotateUnavailable({ driver, online: true, page: { ...page, features: [] } })).toBe(
    "This daemon can't annotate pages. Update ace to use it.",
  );
});

test("a draft's annotations come back after the thread is reopened, and annotating again shows their markers", async () => {
  const { app, view, panel, browser, commands } = await annotating();
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  const pinned = browser.annotations.pin(threadId, { comment: "Still here" });
  await screen.findByRole("button", { name: "Show 1 annotation" });
  view.unmount();
  await app.client.close();
  await waitFor(() => expect(browser.view(threadId)?.annotation).toBeUndefined());

  // A reload: the same device's storage, a new page and connection.
  await harness({ daemon: app.daemon, storage: app.storage }).open(`/t/${threadId}`);
  await screen.findByRole("button", { name: "Show 1 annotation" });
  // The panel comes back as it was left: open on the Browser.
  const reopened = await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(annotateButton(reopened).getAttribute("aria-disabled")).toBeNull());
  commands.length = 0;
  await userEvent.click(annotateButton(reopened));
  await waitFor(() => expect(commands).toContainEqual({ op: "restore", annotations: [pinned] }));
});

test("keys typed at the page never reach the composer, even once the page stops taking them", async () => {
  const { app, panel, browser, message } = await annotating();
  const before = userMessages(app).length;
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  await userEvent.click(within(panel).getByRole("application"));
  await userEvent.keyboard("First");
  act(() => void browser.annotations.pin(threadId, { comment: "First" }));
  await screen.findByRole("button", { name: "Show 1 annotation" });
  expect(browser.inputs.filter((entry) => entry.input.kind === "key").length).toBeGreaterThan(0);

  // Annotate mode ends from the page while the person is at it.
  act(() => browser.annotations.emit(threadId, { kind: "close" }));
  await waitFor(() => expect(browser.view(threadId)?.annotation).toBeUndefined());
  await userEvent.keyboard("Rounder");
  await userEvent.click(within(panel).getByRole("img", { name: /Live view/ }));
  await userEvent.keyboard("corners{Enter}");

  expect(message.textContent).toBe("");
  expect(userMessages(app).length).toBe(before);
});

/** A page element as a region record names it. */
const contained = (tag: string, text: string) => ({
  tag,
  text,
  selector: `#${tag}`,
  xpath: `/html/body/${tag}`,
  box: { x: 0, y: 0, width: 10, height: 10 },
});

test("a dragged-out region joins the draft as a region that lists what it holds", async () => {
  const { panel, browser } = await annotating();
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  act(() =>
    browser.annotations.emit(threadId, {
      kind: "saved",
      annotation: {
        id: "region-1",
        kind: "region",
        number: 1,
        documentId: "doc",
        url: "http://localhost:5173/settings/devices",
        title: "Devices",
        point: { x: 0.5, y: 0.5 },
        comment: "Too cramped",
        element: contained("section", "Pair a device"),
        region: {
          box: { x: 40, y: 80, width: 400, height: 200 },
          elements: [contained("button", "Get started"), contained("p", "Cancel any time")],
        },
        styles: [],
        viewport: { width: 760, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
      },
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Show 1 annotation" }));
  const list = await screen.findByRole("list", { name: "Annotations" });
  expect(within(list).getByText("region")).toBeTruthy();
  expect(within(list).getByText("button “Get started”, p “Cancel any time”")).toBeTruthy();
  expect(within(list).getByText("Too cramped")).toBeTruthy();
  // The section around the region is context for the agent, not the row's text.
  expect(within(list).queryByText("Pair a device")).toBeNull();
});

/** Page screenshots wait here until released, as a busy or slow page makes them wait. */
function holdPageCaptures(browser: Awaited<ReturnType<typeof annotating>>["browser"]) {
  const held: (() => void)[] = [];
  const execute = browser.annotations.execute.bind(browser.annotations);
  browser.annotations.execute = (thread, connection, command) => {
    const result = execute(thread, connection, command);
    if (command.action !== "annotate_capture" || command.target.kind !== "page") return result;
    return new Promise((resolve) => held.push(() => resolve(result)));
  };
  return {
    waiting: () => held.length,
    release: () => {
      for (const release of held.splice(0)) release();
    },
  };
}

/** jsdom has no object URLs: these stand in for the browser's, at its boundary. */
const objectUrls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
function previews() {
  let next = 0;
  URL.createObjectURL = () => `blob:test/${++next}`;
  URL.revokeObjectURL = () => {};
}
afterEach(() => {
  URL.createObjectURL = objectUrls.create;
  URL.revokeObjectURL = objectUrls.revoke;
});

async function pinnedOne() {
  const setup = await annotating();
  await userEvent.type(setup.message, "Fix the heading");
  await userEvent.click(annotateButton(setup.panel));
  await waitFor(() => expect(setup.browser.view(threadId)?.annotation?.owner).toBeTruthy());
  const capture = holdPageCaptures(setup.browser);
  act(() => void setup.browser.annotations.pin(threadId, { comment: "Make this bolder" }));
  await screen.findByRole("button", { name: "Show 1 annotation" });
  return { ...setup, capture };
}

test("pressing Send in the page ends annotate mode and removes the overlay, even while the page's screenshot is still being taken", async () => {
  const { app, panel, browser, capture } = await pinnedOne();
  const before = userMessages(app).length;
  act(() => browser.annotations.emit(threadId, { kind: "send" }));
  await waitFor(() => expect(capture.waiting()).toBe(1));
  await waitFor(() => expect(browser.view(threadId)?.annotation).toBeUndefined());
  await waitFor(() => expect(annotateButton(panel).getAttribute("aria-pressed")).toBe("false"));
  // The screenshot taken meanwhile still goes with the message.
  capture.release();
  await waitFor(() => expect(userMessages(app).slice(before)[0]?.attachments).toHaveLength(2));
}, 20_000);

test("the sent message appears immediately with its annotation card while the screenshot is still being captured and uploaded", async () => {
  const { app, browser, capture } = await pinnedOne();
  const before = userMessages(app).length;
  const feed = screen.getByRole("feed", { name: "Transcript" });
  const pressed = performance.now();
  act(() => browser.annotations.emit(threadId, { kind: "send" }));
  const bubble = await waitFor(() => within(feed).getByText("Fix the heading"), { interval: 5 });
  const shown = performance.now() - pressed;
  const row = bubble.closest(".group\\/bubble");
  if (!(row instanceof HTMLElement)) throw new Error("no bubble");
  expect(within(row).getByText("1 annotation")).toBeTruthy();
  expect(shown).toBeLessThan(100);
  expect(userMessages(app).length).toBe(before);

  // The screenshot arrives later; the message then goes with every image.
  await waitFor(() => expect(capture.waiting()).toBe(1));
  capture.release();
  const sent = await waitFor(() => {
    const [latest] = userMessages(app).slice(before);
    if (!latest?.attachments?.length) throw new Error("not sent yet");
    return latest;
  });
  expect(sent.attachments?.map((file) => file.name)).toEqual([
    "annotated-page-1.png",
    "annotation-1.png",
  ]);
}, 20_000);

test("the pending bubble shows annotation thumbnails, the screenshot's once it is taken", async () => {
  previews();
  const { browser, capture } = await pinnedOne();
  const feed = screen.getByRole("feed", { name: "Transcript" });
  act(() => browser.annotations.emit(threadId, { kind: "send" }));
  const crop = await within(feed).findByRole("img", { name: "annotation-1.png" });
  expect(crop.getAttribute("src")).toMatch(/^blob:test\//);
  expect(within(feed).queryByRole("img", { name: "annotated-page-1.jpg" })).toBeNull();

  await waitFor(() => expect(capture.waiting()).toBe(1));
  capture.release();
  await waitFor(() =>
    expect(
      within(feed)
        .getAllByRole("img")
        .filter((image) => image.getAttribute("src")?.startsWith("blob:test/")),
    ).toHaveLength(2),
  );
}, 20_000);

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
  await within(panel).findByText("is browsing", { exact: false });
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
  // Annotating takes the page from the agent for as long as it lasts.
  expect(browser.view(threadId)?.controller).toBe("human");
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

  // Sending leaves annotate mode, hands the page back and empties the composer.
  await waitFor(() => expect(browser.view(threadId)?.annotation).toBeUndefined());
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
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

test("closing annotate mode from the page hands the page back and keeps the annotations in the draft", async () => {
  const { panel, browser } = await annotating();
  await userEvent.click(annotateButton(panel));
  await waitFor(() => expect(browser.view(threadId)?.annotation?.owner).toBeTruthy());
  act(() => void browser.annotations.pin(threadId, { comment: "Keep me" }));
  await screen.findByRole("button", { name: "Show 1 annotation" });

  act(() => browser.annotations.emit(threadId, { kind: "close" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
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

  // Annotate mode ends from the page and the agent has it back while the person is at it.
  act(() => browser.annotations.emit(threadId, { kind: "close" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
  await userEvent.keyboard("Rounder");
  await userEvent.click(within(panel).getByRole("img", { name: /Live view/ }));
  await userEvent.keyboard("corners{Enter}");

  expect(message.textContent).toBe("");
  expect(userMessages(app).length).toBe(before);
});

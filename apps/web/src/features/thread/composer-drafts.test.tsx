import { fixtureImage, longHistory, replayCursor } from "@ace/fake-daemon";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { newThreadDraftKey } from "@/lib/new-thread-draft-key.ts";

beforeEach(() => localStorage.clear());

/*
 * jsdom can neither decode an image nor draw one: the browser's decoder and canvas are stood in
 * for at that boundary, so a pasted image gets the still a real browser would make of it.
 */
const still = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAA=";
const canvas = HTMLCanvasElement.prototype;
const browser = {
  bitmap: globalThis.createImageBitmap,
  context: canvas.getContext,
  encode: canvas.toDataURL,
};
function standInForImageDecoding() {
  globalThis.createImageBitmap = async () =>
    Object.assign(Object.create(null), { width: 1200, height: 800, close() {} });
  canvas.getContext = function () {
    return Object.assign(Object.create(null), { drawImage() {} });
  } as typeof canvas.getContext;
  canvas.toDataURL = () => still;
}
afterEach(() => {
  globalThis.createImageBitmap = browser.bitmap;
  canvas.getContext = browser.context;
  canvas.toDataURL = browser.encode;
});
const pastedImage = () =>
  new File([Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0))], "shot.png", {
    type: "image/png",
  });

function app(storage = memoryKeyValue()) {
  const made = harness({ storage });
  made.play(longHistory(2)).runUntilBlocked();
  made.play(replayCursor()).runThrough("finding");
  return made;
}
const message = () => screen.findByRole("combobox", { name: "Message" });
const threads = () => screen.getByRole("navigation", { name: "Threads" });

test("an unsent draft is still there after visiting another thread", async () => {
  await app().open("/t/thread-router");
  await userEvent.type(await message(), "Half a thought about nested routes");

  await userEvent.click(within(threads()).getByRole("link", { name: /Replay cursor resets/ }));
  await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
  // The other thread has its own, empty draft.
  expect((await message()).textContent).toBe("");

  await userEvent.click(within(threads()).getByRole("link", { name: /Document the router/ }));
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  expect((await message()).textContent).toBe("Half a thought about nested routes");
});

test.each(["focused", "unfocused"])(
  "a %s retained draft exposes another tab's durable version without replacing local recovery",
  async (focus) => {
    const storage = memoryKeyValue();
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key === "ace.composer.drafts") throw new Error("QuotaExceededError");
      setItem(key, value);
    };
    await app(storage).open("/t/thread-router");
    const editor = await message();
    await userEvent.type(editor, "My unsaved version");
    fireEvent(window, new Event("pagehide"));
    await screen.findByText("Draft not saved: storage full");
    if (focus === "unfocused") editor.blur();
    // Another browser tab's accepted write goes through the shared durable storage boundary.
    const newer = JSON.stringify([
      [
        "thread:thread-router",
        { text: "Other tab's saved version", mentions: [], attachments: [] },
      ],
    ]);
    setItem("ace.composer.drafts", newer);
    fireEvent(window, new StorageEvent("storage", { key: "ace.composer.drafts", newValue: newer }));
    await screen.findByText(/Edited in another window/);
    expect(editor.textContent).toBe("My unsaved version");
    await screen.findByText("Draft not saved: storage full");
    // Another refused flush must preserve both the visible copy and the competing durable copy.
    fireEvent(window, new Event("pagehide"));
    expect(storage.getItem("ace.composer.drafts")).toBe(newer);
    await userEvent.click(screen.getByRole("button", { name: "Use that version" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
        "Other tab's saved version",
      ),
    );
  },
);

test("a full draft store warns and retains the latest text across navigation until it can save", async () => {
  const storage = memoryKeyValue();
  const setItem = storage.setItem.bind(storage);
  let full = false;
  storage.setItem = (key, value) => {
    if (full && key === "ace.composer.drafts") throw new Error("QuotaExceededError");
    setItem(key, value);
  };
  await app(storage).open("/t/thread-router");
  await userEvent.type(await message(), "Previously saved");
  fireEvent(window, new Event("pagehide"));
  full = true;
  await userEvent.clear(await message());
  await userEvent.type(await message(), "Latest unsaved version");
  fireEvent(window, new Event("pagehide"));
  await screen.findByText("Draft not saved: storage full");
  expect(storage.getItem("ace.composer.drafts")).toContain("Previously saved");
  expect(storage.getItem("ace.composer.drafts")).not.toContain("Latest unsaved version");
  await userEvent.click(within(threads()).getByRole("link", { name: /Replay cursor resets/ }));
  await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
  expect((await message()).textContent).toBe("");
  await userEvent.click(within(threads()).getByRole("link", { name: /Document the router/ }));
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  expect((await message()).textContent).toBe("Latest unsaved version");
  await screen.findByText("Draft not saved: storage full");
  full = false;
  fireEvent(window, new Event("pagehide"));
  await waitFor(() => expect(screen.queryByText("Draft not saved: storage full")).toBeNull());
  expect(storage.getItem("ace.composer.drafts")).toContain("Latest unsaved version");
  cleanup();
  await app(storage).open("/t/thread-router");
  expect((await message()).textContent).toBe("Latest unsaved version");
});

test("a draft and its uploaded files survive a reload, and go once the message is sent", async () => {
  const storage = memoryKeyValue();
  const running = app(storage);
  await running.open("/t/thread-router");
  await userEvent.type(await message(), "Compare with @");
  await userEvent.keyboard("{Escape}");
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(
      [Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0))],
      "routes.png",
      {
        type: "image/png",
      },
    ),
  );
  const chips = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  cleanup();

  // A browser reload retains the daemon, including its scoped upload bytes.
  const reloaded = running;
  await reloaded.open("/t/thread-router");
  const field = await message();
  expect(field.textContent).toBe("Compare with @");
  expect(
    within(screen.getByRole("list", { name: "Attachments" })).getByText("routes.png"),
  ).toBeTruthy();

  await userEvent.clear(field);
  await userEvent.type(field, "Compare with the table{Enter}");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Compare with the table")).toBeTruthy();
  cleanup();

  await running.open("/t/thread-router");
  expect((await message()).textContent).toBe("");
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});

test("a new-thread draft restores after the project directory becomes available on a fresh page", async () => {
  const storage = memoryKeyValue();
  const made = app(storage);
  storage.setItem(
    "ace.composer.drafts",
    JSON.stringify([
      [
        newThreadDraftKey(made.daemon.hostId, "relay"),
        {
          text: "Keep this new-thread draft",
          mentions: [],
          attachments: [],
        },
      ],
    ]),
  );
  await made.open("/new?project=relay");
  expect((await message()).textContent).toBe("Keep this new-thread draft");
});

test("a new-thread draft with a pasted image shows its preview after the page is reopened", async () => {
  standInForImageDecoding();
  const storage = memoryKeyValue();
  const made = app(storage);
  await made.open("/new?project=relay");
  fireEvent.paste(await message(), { clipboardData: { files: [pastedImage()], items: [] } });
  await screen.findByRole("button", { name: "Remove shot.png" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading shot.png" })).toBeNull(),
  );
  await waitFor(() => expect(storage.getItem("ace.composer.drafts")).toContain(still));
  cleanup();

  // A fresh page: the file itself is gone, and a draft scope has no copy this page can read.
  await app(storage).open("/new?project=relay");
  const chips = await screen.findByRole("list", { name: "Attachments" });
  const preview = await within(chips).findByRole("img", { name: "shot.png" });
  expect(preview.getAttribute("src")).toBe(still);
});

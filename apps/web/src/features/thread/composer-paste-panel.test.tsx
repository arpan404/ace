import { longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { cleanup, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * A long paste's text, edited in the thread's side panel: its chip opens a tab named after the
 * file, typing is kept a moment after it pauses (and before a send), the tab follows the chip
 * through its edited copies and goes with it, and it never comes back after a reload. Where the
 * panel can't open (the New thread screen) the chip edits in a dialog as before.
 */

beforeEach(() => localStorage.clear());

const threadId = ThreadId.parse("thread-router");
const log = Array.from({ length: 60 }, (_, line) => `error at line ${line}`).join("\n");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const pasteText = (target: HTMLElement, text: string) =>
  fireEvent.paste(target, { clipboardData: { files: [], items: [], getData: () => text } });

async function pasted(app = harness()) {
  const user = userEvent.setup();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await user.click(message);
  pasteText(message, log);
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  return { app, user, message, chips };
}

/** Opens the chip's text in the panel; the tab and its field. */
async function openInPanel(user: ReturnType<typeof userEvent.setup>, chips: HTMLElement) {
  await user.click(within(chips).getByRole("button", { name: "Preview Pasted 60 lines.txt" }));
  const tab = await screen.findByRole("tab", { name: /Pasted 60 lines\.txt/ });
  const region = await screen.findByRole("region", { name: "Pasted 60 lines.txt" });
  const field = await within(region).findByRole("textbox", { name: "File contents" });
  return { tab, region, field };
}

async function held(app: ReturnType<typeof harness>) {
  const listed = await app.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId },
  });
  return listed.result.kind === "attachments"
    ? listed.result.attachments.map((file) => ({ name: file.name, sha256: file.sha256 }))
    : [];
}

function sentFiles(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "thread", threadId });
  if (!view || !("items" in view)) throw new Error("Missing transcript");
  const sent = Object.values(view.items).find(
    (item) => item.type === "message" && item.role === "user" && item.attachments?.length,
  );
  if (sent?.type !== "message") throw new Error("Attachment message not admitted");
  return sent.attachments?.map((file) => file.sha256);
}

test("a pasted chip opens its text in a panel tab, and the chip shows it is being edited", async () => {
  const { user, chips } = await pasted();
  const { field } = await openInPanel(user, chips);
  expect((field as HTMLTextAreaElement).value).toBe(log);
  expect(screen.queryByRole("dialog")).toBeNull();
  const chip = within(chips).getByRole("button", { name: "Preview Pasted 60 lines.txt" });
  expect(chip.getAttribute("aria-current")).toBe("true");

  // Opening it again shows the same tab rather than a second one.
  await user.click(chip);
  expect(screen.getAllByRole("tab", { name: /Pasted 60 lines\.txt/ })).toHaveLength(1);
});

test("typing then pausing puts the edited text in the chip's place, under its new name", async () => {
  const { app, user, chips, message } = await pasted();
  const { field } = await openInPanel(user, chips);
  await user.clear(field);
  await user.type(field, "error at line 7{Enter}error at line 9");

  const renamed = await within(chips).findByRole(
    "button",
    { name: "Preview Pasted 2 lines.txt" },
    { timeout: 3000 },
  );
  expect(renamed.getAttribute("aria-current")).toBe("true");
  expect(within(message).getByLabelText("Pasted 2 lines.txt")).toBeTruthy();
  // The tab follows its chip: renamed, still one, still holding the typing.
  await screen.findByRole("tab", { name: /Pasted 2 lines\.txt/ });
  expect(screen.queryByRole("tab", { name: /Pasted 60 lines\.txt/ })).toBeNull();
  expect((field as HTMLTextAreaElement).value).toBe("error at line 7\nerror at line 9");
  // The daemon holds the edited bytes, and the unedited copy is gone.
  await waitFor(async () =>
    expect(await held(app)).toEqual([
      { name: "Pasted 2 lines.txt", sha256: hash("error at line 7\nerror at line 9") },
    ]),
  );
});

test("sending straight after typing sends the edited text and closes the tab", async () => {
  const { app, user, chips } = await pasted();
  const { field } = await openInPanel(user, chips);
  await user.clear(field);
  await user.type(field, "only this");
  await user.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(sentFiles(app)).toEqual([hash("only this")]));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Pasted/ })).toBeNull());
});

test("closing the tab keeps what was typed", async () => {
  const { user, chips } = await pasted();
  const { field } = await openInPanel(user, chips);
  await user.clear(field);
  await user.type(field, "kept on close");
  await user.click(screen.getByRole("button", { name: /^Close Pasted 60 lines\.txt/ }));

  await waitFor(() => expect(screen.queryByRole("tab", { name: /Pasted/ })).toBeNull());
  const chip = within(chips).getByRole("button", { name: "Preview Pasted 1 line.txt" });
  expect(chip.getAttribute("aria-current")).toBeNull();
});

test("removing the chip closes its tab", async () => {
  const { user, chips } = await pasted();
  await openInPanel(user, chips);
  await user.click(within(chips).getByRole("button", { name: "Remove Pasted 60 lines.txt" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Pasted/ })).toBeNull());
});

test("a reload never brings the tab back", async () => {
  const storage = memoryKeyValue();
  const first = harness({ storage });
  const { user, chips } = await pasted(first);
  await openInPanel(user, chips);
  // The page goes away as it is, without leaving the thread first.
  const kept = memoryKeyValue();
  for (const [key, value] of storage.data) kept.setItem(key, value);
  cleanup();

  const again = harness({ storage: kept });
  again.play(longHistory(2)).runUntilBlocked();
  await again.open("/t/thread-router");
  await screen.findByRole("combobox", { name: "Message" });
  // The panel comes back as it was, less the edit's tab.
  await screen.findByRole("tab", { name: /Summary/ });
  expect(screen.queryByRole("tab", { name: /Pasted/ })).toBeNull();
});

test("on the New thread screen, with no panel beside it, the chip edits in a dialog", async () => {
  const user = userEvent.setup();
  const app = harness();
  await app.open("/new");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await user.click(message);
  pasteText(message, log);
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await user.click(within(chips).getByRole("button", { name: "Preview Pasted 60 lines.txt" }));
  const dialog = await screen.findByRole("dialog", { name: "Pasted 60 lines.txt" });
  expect(within(dialog).getByRole("button", { name: "Save" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Pasted/ })).toBeNull();
});

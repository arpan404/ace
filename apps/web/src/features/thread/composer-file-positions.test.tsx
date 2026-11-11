import { fixtureImage, longHistory } from "@ace/fake-daemon";
import type { Command } from "@ace/protocol";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * The composer as rich text: a file added mid-message is marked where the caret was and goes
 * with its offset in the words; lists and bold are typed as Markdown.
 */

const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  localStorage.clear();
  let next = 0;
  URL.createObjectURL = () => `blob:test/${++next}`;
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

const png = Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0));
const screenshot = () => new File([png], "screen.png", { type: "image/png" });
const pngHash = createHash("sha256").update(png).digest("hex");

async function openComposer() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  // Every command the composer sends, as the daemon receives it.
  const commands: Command[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command: Command) => {
    commands.push(command);
    return receive(command);
  };
  await app.open("/t/thread-router");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.click(message);
  return { app, message, commands };
}
const pasteText = (target: HTMLElement, text: string) =>
  fireEvent.paste(target, { clipboardData: { files: [], items: [], getData: () => text } });
const pasteFile = (target: HTMLElement, file: File) =>
  fireEvent.paste(target, { clipboardData: { files: [file], items: [] } });
async function uploaded() {
  const chips = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  return chips;
}
function sent(commands: readonly Command[]) {
  const send = commands.find((command) => command.payload.type === "thread.send")?.payload;
  if (send?.type !== "thread.send") throw new Error("Nothing sent yet");
  return send;
}

test("a file added mid-message goes with where it was put, and its marker never goes as text", async () => {
  const { message, commands } = await openComposer();
  pasteText(message, "look at ");
  pasteFile(message, screenshot());
  pasteText(message, " please");
  await uploaded();
  // Its chip stays on top; its marker stands in the words.
  expect(within(message).getByLabelText("screen.png")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const payload = sent(commands);
    expect(payload.input).toEqual([{ type: "text", text: "look at  please" }]);
    expect(payload.context?.attachments).toEqual([{ sha256: pngHash, at: 8 }]);
  });
});

test("a file sent while it still uploads keeps its place", async () => {
  const { message, commands } = await openComposer();
  pasteText(message, "before ");
  pasteFile(message, screenshot());
  pasteText(message, "after");
  // Enter at once: the message waits for the upload, then goes.
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() =>
    expect(sent(commands).context?.attachments).toEqual([{ sha256: pngHash, at: 7 }]),
  );
  expect(sent(commands).input).toEqual([{ type: "text", text: "before after" }]);
});

test("removing a file's chip takes its marker out of the words", async () => {
  const { message } = await openComposer();
  pasteText(message, "see ");
  pasteFile(message, screenshot());
  const chips = await uploaded();
  await userEvent.click(within(chips).getByRole("button", { name: "Remove screen.png" }));
  await waitFor(() => expect(within(message).queryByLabelText("screen.png")).toBeNull());
  expect(message.textContent).toBe("see ");
});

test("deleting a file's marker from the words removes the file", async () => {
  const { message } = await openComposer();
  pasteText(message, "see ");
  pasteFile(message, screenshot());
  await uploaded();
  // As Backspace over the chip leaves the editor.
  within(message).getByLabelText("screen.png").remove();
  fireEvent.input(message);
  await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
});

test("the newline key continues a list and Tab nests the new item; Enter still sends", async () => {
  const { message, commands } = await openComposer();
  pasteText(message, "1. milk");
  fireEvent.keyDown(message, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(message.textContent).toBe("1. milk\n2. "));
  fireEvent.keyDown(message, { key: "Tab" });
  await waitFor(() => expect(message.textContent).toBe("1. milk\n   1. "));
  pasteText(message, "oat");
  expect(message.querySelector('[data-md="number"][data-depth="2"]')?.textContent).toBe("1.");
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() =>
    expect(sent(commands).input).toEqual([{ type: "text", text: "1. milk\n   1. oat" }]),
  );
});

test("⌘B starts bold words at the caret, drawn bold and sent as Markdown", async () => {
  const { message, commands } = await openComposer();
  pasteText(message, "make ");
  fireEvent.keyDown(message, { key: "b", metaKey: true });
  await waitFor(() => expect(message.textContent).toBe("make ****"));
  pasteText(message, "this");
  await waitFor(() =>
    expect(message.querySelector('[data-md="bold"]')?.textContent).toBe("**this**"),
  );
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() =>
    expect(sent(commands).input).toEqual([{ type: "text", text: "make **this**" }]),
  );
});

test("a heading is drawn as one as soon as its marks are typed", async () => {
  const { message } = await openComposer();
  pasteText(message, "## Plan");
  await waitFor(() => expect(message.querySelector('[data-md="h2"]')?.textContent).toBe("## Plan"));
});

test("a kept draft brings its file's marker back where it was, and it still goes with its place", async () => {
  const { app, message, commands } = await openComposer();
  pasteText(message, "look ");
  pasteFile(message, screenshot());
  pasteText(message, " here");
  await uploaded();
  await app.open("/");
  await app.open("/t/thread-router");
  const reopened = await screen.findByRole("combobox", { name: "Message" });
  await waitFor(() => expect(within(reopened).getByLabelText("screen.png")).toBeTruthy());
  expect(reopened.textContent).toBe("look screen.png here");
  fireEvent.keyDown(reopened, { key: "Enter" });
  await waitFor(() =>
    expect(sent(commands).context?.attachments).toEqual([{ sha256: pngHash, at: 5 }]),
  );
});

test("editing a pasted file renames its marker with it", async () => {
  const user = userEvent.setup();
  const { message } = await openComposer();
  pasteText(message, Array.from({ length: 60 }, (_, line) => `line ${line}`).join("\n"));
  const chips = await uploaded();
  expect(within(message).getByLabelText("Pasted 60 lines.txt")).toBeTruthy();
  await user.click(within(chips).getByRole("button", { name: "Preview Pasted 60 lines.txt" }));
  const dialog = await screen.findByRole("dialog", { name: "Pasted 60 lines.txt" });
  const contents = await within(dialog).findByRole("textbox", { name: "File contents" });
  await user.clear(contents);
  await user.type(contents, "one{Enter}two");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(within(message).getByLabelText("Pasted 2 lines.txt")).toBeTruthy());
  expect(within(message).queryByLabelText("Pasted 60 lines.txt")).toBeNull();
});

test("a copy of a chip dropped into the words stands for no file: the file stays and keeps its place", async () => {
  const { message, commands } = await openComposer();
  pasteText(message, "see ");
  pasteFile(message, screenshot());
  await uploaded();
  // The browser drops a copy of the chip's element, which the composer never made.
  const copy = within(message).getByLabelText("screen.png").cloneNode(true);
  message.prepend(copy);
  fireEvent.input(message);
  await waitFor(() => expect(within(message).getAllByLabelText("screen.png")).toHaveLength(1));
  // Nothing of the copy is left in the words.
  expect(message.textContent).toBe("see screen.png");
  expect(screen.getByRole("list", { name: "Attachments" })).toBeTruthy();
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() =>
    expect(sent(commands).context?.attachments).toEqual([{ sha256: pngHash, at: 4 }]),
  );
  expect(sent(commands).input).toEqual([{ type: "text", text: "see " }]);
});

test("text dropped into the composer goes in as plain words, never as a file's marker", async () => {
  const { message } = await openComposer();
  pasteText(message, "a ");
  const dropped = `b${String.fromCharCode(0xfffc)}c`;
  fireEvent.drop(message, {
    dataTransfer: { files: [], items: [], types: ["text/plain"], getData: () => dropped },
  });
  await waitFor(() => expect(message.textContent).toBe("a bc"));
});

test("undo takes a file's marker away but keeps the file, and redo puts the marker back", async () => {
  const { message, commands } = await openComposer();
  pasteText(message, "see ");
  pasteFile(message, screenshot());
  await uploaded();
  fireEvent.keyDown(message, { key: "z", metaKey: true });
  await waitFor(() => expect(within(message).queryByLabelText("screen.png")).toBeNull());
  const chips = screen.getByRole("list", { name: "Attachments" });
  expect(within(chips).getByRole("button", { name: "Remove screen.png" })).toBeTruthy();
  fireEvent.keyDown(message, { key: "z", metaKey: true, shiftKey: true });
  await waitFor(() => expect(within(message).getByLabelText("screen.png")).toBeTruthy());
  fireEvent.keyDown(message, { key: "z", metaKey: true });
  await waitFor(() => expect(within(message).queryByLabelText("screen.png")).toBeNull());
  // Without its marker it goes with no place: after the words.
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() => expect(sent(commands).context?.attachments).toEqual([{ sha256: pngHash }]));
});

test("undo after editing a pasted file keeps the marker, named for the edited copy", async () => {
  const user = userEvent.setup();
  const { message } = await openComposer();
  pasteText(message, Array.from({ length: 60 }, (_, line) => `line ${line}`).join("\n"));
  const chips = await uploaded();
  pasteText(message, " and more");
  await user.click(within(chips).getByRole("button", { name: "Preview Pasted 60 lines.txt" }));
  const dialog = await screen.findByRole("dialog", { name: "Pasted 60 lines.txt" });
  const contents = await within(dialog).findByRole("textbox", { name: "File contents" });
  await user.clear(contents);
  await user.type(contents, "one{Enter}two");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(within(message).getByLabelText("Pasted 2 lines.txt")).toBeTruthy());
  fireEvent.keyDown(message, { key: "z", metaKey: true });
  await waitFor(() => expect(message.textContent).not.toContain("and more"));
  expect(within(message).getByLabelText("Pasted 2 lines.txt")).toBeTruthy();
});

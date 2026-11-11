import { longHistory } from "@ace/fake-daemon";
import type { Command } from "@ace/protocol";
import { act, configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { overrideKeyboardEnv } from "@/lib/keybindings.ts";
import { harness } from "@/test/harness.tsx";
import { editorText, insertEditorText, placeEditorCaret } from "./composer/editor-dom.ts";

configure({ asyncUtilTimeout: 10000 });

/*
 * The composer as rich text: the person sees bold words, headings and list bullets, never the
 * Markdown syntax that writes them; the agent gets the Markdown.
 */

beforeEach(() => localStorage.clear());
afterEach(() => overrideKeyboardEnv(undefined));

async function openComposer() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  const commands: Command[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command: Command) => {
    commands.push(command);
    return receive(command);
  };
  await app.open("/t/thread-router");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.click(message);
  return { message, commands };
}
const pasteText = (target: HTMLElement, text: string) =>
  fireEvent.paste(target, { clipboardData: { files: [], items: [], getData: () => text } });
/**
 * Type words as the keyboard does: the composer may take them first (⌘B's bold or plain). Each
 * keystroke is its own task in a browser, so the composer has drawn it before the next.
 */
async function typeWords(target: HTMLElement, words: string) {
  const event = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: words,
    bubbles: true,
    cancelable: true,
  });
  if (target.dispatchEvent(event)) insertEditorText(target, words);
  await act(async () => {});
}
/** The lines as the person sees them. */
const seen = (message: HTMLElement) =>
  [...message.children].map((line) => line.textContent ?? "").join("\n");
function sent(commands: readonly Command[]) {
  const send = commands.find((command) => command.payload.type === "thread.send")?.payload;
  if (send?.type !== "thread.send") throw new Error("Nothing sent yet");
  return send.input;
}

test("words typed between ** turn bold with no marks shown, and go as Markdown", async () => {
  const { message, commands } = await openComposer();
  await typeWords(message, "say **a. ahhas**");
  await waitFor(() => expect(message.querySelector("strong")?.textContent).toBe("a. ahhas"));
  expect(seen(message)).toBe("say a. ahhas");
  // Bold, never italic.
  expect(message.querySelector("em, i")).toBeNull();
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() => expect(sent(commands)).toEqual([{ type: "text", text: "say **a. ahhas**" }]));
});

test("⌘B at a bare caret makes the next words bold, and ⌘B again ends the bold", async () => {
  overrideKeyboardEnv({ apple: true, web: true });
  const { message } = await openComposer();
  await typeWords(message, "make ");
  fireEvent.keyDown(message, { key: "b", metaKey: true });
  // Nothing shows until words are typed.
  expect(seen(message)).toBe("make ");
  await typeWords(message, "this");
  await waitFor(() => expect(message.querySelector("strong")?.textContent).toBe("this"));
  fireEvent.keyDown(message, { key: "b", metaKey: true });
  await typeWords(message, " plain");
  await waitFor(() => expect(editorText(message)).toBe("make **this** plain"));
  expect(seen(message)).toBe("make this plain");
  expect(message.querySelector("strong")?.textContent).toBe("this");
});

test("typing right after bold words carries the bold on, past a space too", async () => {
  const { message } = await openComposer();
  await typeWords(message, "**ab**");
  await waitFor(() => expect(message.querySelector("strong")?.textContent).toBe("ab"));
  await typeWords(message, "c");
  await waitFor(() => expect(editorText(message)).toBe("**abc**"));
  await typeWords(message, " ");
  await typeWords(message, "d");
  await waitFor(() => expect(editorText(message)).toBe("**abc** **d**"));
  expect(seen(message)).toBe("abc d");
});

test("elsewhere Ctrl+B bolds what is typed next", async () => {
  overrideKeyboardEnv({ apple: false, web: true });
  const { message } = await openComposer();
  await typeWords(message, "make ");
  fireEvent.keyDown(message, { key: "b", ctrlKey: true });
  await typeWords(message, "this");
  await waitFor(() => expect(editorText(message)).toBe("make **this**"));
});

test("on a Mac, Ctrl+B is left to the system's back-one-letter", async () => {
  overrideKeyboardEnv({ apple: true, web: true });
  const { message } = await openComposer();
  await typeWords(message, "word");
  expect(fireEvent.keyDown(message, { key: "b", ctrlKey: true })).toBe(true);
  expect(editorText(message)).toBe("word");
});

test("⌘B on selected words bolds them without showing marks", async () => {
  overrideKeyboardEnv({ apple: true, web: true });
  const { message } = await openComposer();
  await typeWords(message, "make this bold");
  const words = message.querySelector("[data-line]")?.firstChild;
  if (!words) throw new Error("No words");
  const range = document.createRange();
  range.setStart(words, 5);
  range.setEnd(words, 9);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  fireEvent.keyDown(message, { key: "b", metaKey: true });
  await waitFor(() => expect(message.querySelector("strong")?.textContent).toBe("this"));
  expect(seen(message)).toBe("make this bold");
  expect(editorText(message)).toBe("make **this** bold");
});

test("# typed at a line's start makes a heading with no # shown; Backspace at its start undoes it", async () => {
  const { message } = await openComposer();
  await typeWords(message, "## Plan");
  await waitFor(() => expect(message.querySelector('[data-md="h2"]')?.textContent).toBe("Plan"));
  expect(seen(message)).toBe("Plan");
  placeEditorCaret(message, 3);
  fireEvent.keyDown(message, { key: "Backspace" });
  await waitFor(() => expect(message.querySelector('[data-md="h2"]')).toBeNull());
  expect(editorText(message)).toBe("Plan");
});

test("list markers are drawn, never text; Backspace at an item's start takes off its bullet", async () => {
  const { message } = await openComposer();
  pasteText(message, "- a\n  - b");
  await waitFor(() => expect(message.querySelectorAll('[data-md="item"]')).toHaveLength(2));
  expect(seen(message)).toBe("a\nb");
  // The nested item steps out a level first, then loses its bullet.
  placeEditorCaret(message, editorText(message).length - 1);
  fireEvent.keyDown(message, { key: "Backspace" });
  await waitFor(() => expect(editorText(message)).toBe("- a\n- b"));
  placeEditorCaret(message, editorText(message).length - 1);
  fireEvent.keyDown(message, { key: "Backspace" });
  await waitFor(() => expect(editorText(message)).toBe("- a\nb"));
  expect(seen(message)).toBe("a\nb");
});

test("the newline key continues a list and Tab nests the new item; Enter still sends", async () => {
  const { message, commands } = await openComposer();
  await typeWords(message, "1. milk");
  fireEvent.keyDown(message, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(editorText(message)).toBe("1. milk\n2. "));
  fireEvent.keyDown(message, { key: "Tab" });
  await waitFor(() => expect(editorText(message)).toBe("1. milk\n   1. "));
  await typeWords(message, "oat");
  const nested = message.querySelector('[data-md="item"][data-depth="2"]');
  expect(nested?.getAttribute("data-glyph")).toBe("1.");
  expect(seen(message)).toBe("milk\noat");
  fireEvent.keyDown(message, { key: "Enter" });
  await waitFor(() =>
    expect(sent(commands)).toEqual([{ type: "text", text: "1. milk\n   1. oat" }]),
  );
});

test("the newline key inside bold words leaves both halves bold, no marks shown", async () => {
  const { message } = await openComposer();
  await typeWords(message, "**abcd**");
  await waitFor(() => expect(message.querySelector("strong")).not.toBeNull());
  placeEditorCaret(message, 4);
  fireEvent.keyDown(message, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(editorText(message)).toBe("**ab**\n**cd**"));
  expect(seen(message)).toBe("ab\ncd");
});

test("fenced code shows exactly what was typed", async () => {
  const { message } = await openComposer();
  pasteText(message, "```\n# **x**\n```");
  await waitFor(() => expect(seen(message)).toBe("```\n# **x**\n```"));
  expect(message.querySelector("strong, [data-md='h1']")).toBeNull();
});

import { longHistory, replayCursor } from "@ace/fake-daemon";
import type { ContentPart } from "@ace/protocol";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => {
  localStorage.clear();
  // jsdom lays nothing out and has no range boxes: every selected line reads as one on screen.
  const line = { top: 0, bottom: 0, left: 0, right: 10, width: 10, height: 0, x: 0, y: 0 };
  Range.prototype.getClientRects = () =>
    Object.assign([line], { item: () => line }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => line as DOMRect;
});
afterEach(() => {
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

const threadId = "thread-router";

async function open() {
  const app = harness({ storage: memoryKeyValue() });
  app.play(longHistory(2)).runUntilBlocked();
  app.play(replayCursor()).runThrough("finding");
  const sent: ContentPart[][] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.input);
    return receive(command);
  };
  await app.open(`/t/${threadId}`);
  return { sent, message: await screen.findByRole("combobox", { name: "Message" }) };
}

/** Select `words` in the on-screen text that holds them, as a double click would. */
function pick(words: string) {
  const holder = screen.getByText((_, element) =>
    [...(element?.childNodes ?? [])].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(words),
    ),
  );
  const node = [...holder.childNodes].find((child) => child.textContent?.includes(words));
  if (!node) throw new Error(`No text with "${words}"`);
  const start = node.textContent?.indexOf(words) ?? 0;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + words.length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return holder;
}

/** Select `words` as a drag would, and let go. */
function select(words: string) {
  fireEvent.pointerUp(pick(words));
}

/** Select `words` in an answer once it has settled into its rendered form, and press Reply. */
async function reply(words: string) {
  await waitFor(() => {
    select(words);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  });
  return screen.findByRole("list", { name: "Replying to" });
}

const textOf = (input: readonly ContentPart[] | undefined) =>
  input?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";

test("a reply to a selected passage tells the agent which of its words it answers", async () => {
  const { sent, message } = await open();
  const quoted = await reply("route 2 renders its own panel");
  expect(within(quoted).getByText("route 2 renders its own panel")).toBeTruthy();
  // The caret is in the message box, ready for the reply.
  await waitFor(() => expect(document.activeElement).toBe(message));

  await userEvent.type(message, "Which panel exactly?{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  const text = textOf(sent[0]);
  expect(text.startsWith('<replying_to version="1">')).toBe(true);
  expect(text).toContain("replies to this part of one of your earlier messages");
  expect(text).toContain('Passage: "route 2 renders its own panel"');
  expect(text).toContain('In context: "Answer 2: route 2 renders its own panel."');
  expect(text.endsWith("Which panel exactly?")).toBe(true);

  // The sent bubble shows the quote above the words, never the block the agent reads; the
  // composer is clear for the next message.
  const feed = screen.getByRole("feed", { name: "Transcript" });
  const shown = await within(feed).findByRole("list", { name: "Replying to" });
  expect(within(shown).getByText("route 2 renders its own panel")).toBeTruthy();
  expect(within(feed).getByText("Which panel exactly?")).toBeTruthy();
  expect(document.body.textContent).not.toContain("replying_to");
  const composer = document.querySelector<HTMLElement>('[data-slot="composer"]');
  expect(composer && within(composer).queryByRole("list", { name: "Replying to" })).toBeNull();
});

test("a quote can be dropped before sending, and the message goes without it", async () => {
  const { sent, message } = await open();
  await reply("route 1 renders");
  await userEvent.click(screen.getByRole("button", { name: "Remove quote" }));
  expect(screen.queryByRole("list", { name: "Replying to" })).toBeNull();

  await userEvent.type(message, "Never mind.{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(textOf(sent[0])).toBe("Never mind.");
});

test("a quote waiting in the draft is still there after visiting another thread", async () => {
  await open();
  await reply("route 2 renders");

  const threads = screen.getByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /Replay cursor resets/ }));
  await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
  expect(screen.queryByRole("list", { name: "Replying to" })).toBeNull();

  await userEvent.click(within(threads).getByRole("link", { name: /Document the router/ }));
  const quoted = await screen.findByRole("list", { name: "Replying to" });
  expect(within(quoted).getByText("route 2 renders")).toBeTruthy();
});

test("a word picked by double click offers Reply once the selection lands", async () => {
  await open();
  await waitFor(() => {
    // The click's release came before the word was selected; only the selection says so.
    pick("Answer 2");
    document.dispatchEvent(new Event("selectionchange"));
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });
});

test("a triple-clicked paragraph that runs past the answer quotes just the answer's words", async () => {
  await open();
  await waitFor(() => {
    // A triple click ends the selection at the start of what follows the paragraph.
    const holder = pick("Answer 2");
    const answer = holder.closest("[data-quotable]");
    const after = answer?.parentElement?.querySelector("time");
    const selection = document.getSelection();
    const range = selection?.getRangeAt(0);
    if (!answer || !after || !range) throw new Error("No answer with a time under it");
    range.setStart(answer, 0);
    range.setEnd(after, 0);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  });
  const quoted = await screen.findByRole("list", { name: "Replying to" });
  expect(within(quoted).getByRole("listitem").textContent).toBe(
    "Answer 2: route 2 renders its own panel.",
  );
});

test("selecting the person's own question offers no reply", async () => {
  await open();
  await waitFor(() => {
    select("route 1 renders");
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });
  select("what does route 1 render?");

  expect(document.getSelection()?.toString()).toBe("what does route 1 render?");
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

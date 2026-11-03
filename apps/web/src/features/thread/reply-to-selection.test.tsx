import { longHistory } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
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
});
afterEach(() => {
  Reflect.deleteProperty(Range.prototype, "getClientRects");
});

const threadId = "thread-router";

async function open() {
  const app = harness({ storage: memoryKeyValue() });
  app.play(longHistory(2)).runUntilBlocked();
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.input);
    return receive(command);
  };
  await app.open(`/t/${threadId}`);
  return { sent, message: await screen.findByRole("combobox", { name: "Message" }) };
}

/** Select `words` in the on-screen text that holds them, as a drag would, and let go. */
function select(words: string) {
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
  fireEvent.pointerUp(holder);
}

/** Select `words` once the answer has settled into its rendered form, and see Reply offered. */
async function selectInAnswer(words: string) {
  await waitFor(() => {
    select(words);
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });
}

test("selected words of an agent's answer go to the agent quoted above the reply", async () => {
  const { sent, message } = await open();
  await selectInAnswer("route 2 renders its own panel");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));

  expect(message.textContent).toBe("> route 2 renders its own panel\n\n");
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  await userEvent.type(message, "Which panel?{Enter}");
  await waitFor(() =>
    expect(sent.at(-1)).toEqual([
      { type: "text", text: "> route 2 renders its own panel\n\nWhich panel?" },
    ]),
  );
});

test("selecting the person's own question offers no reply", async () => {
  await open();
  await selectInAnswer("route 1 renders");
  select("what does route 1 render?");

  expect(document.getSelection()?.toString()).toBe("what does route 1 render?");
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

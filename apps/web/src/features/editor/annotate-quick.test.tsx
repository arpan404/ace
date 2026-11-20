import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openThread, select } from "./test/annotate-thread.tsx";

/*
 * Quick agent actions on a selection: Fix this and Explain are annotations at once with their
 * words filled in and open to change; Ask about this opens the comment for the question. What
 * the person wants reaches the agent as an intent it can act on.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const path = "src/retry.ts";
const source = ["export async function retry(run) {", "  while (true) await run();", "}"].join(
  "\n",
);
const chip = () => screen.queryByRole("button", { name: /^Show \d+ annotations?$/ });
const pressed = (popover: HTMLElement) =>
  within(popover)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);

async function bar() {
  return screen.findByRole("toolbar", { name: "Annotate selection" });
}

test("Fix this annotates at once with its words filled in, still open to change", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  select(editor(), [1, 2], [1, 27]);
  await userEvent.click(within(await bar()).getByRole("button", { name: "Fix this" }));

  const popover = await screen.findByRole("dialog", { name: "Annotation 1" });
  expect(chip()?.textContent).toBe("1 annotation");
  expect(pressed(popover)).toEqual(["Fix"]);
  const comment = within(popover).getByRole("textbox", { name: "Comment" });
  expect((comment as HTMLTextAreaElement).value).toBe("Fix this.");
  await userEvent.clear(comment);
  await userEvent.type(comment, "Stop after three tries{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(sent[0]).toContain(
    "Intent: fix. Change the code.\nComment: Stop after three tries\nCode:\n```\nwhile (true) await run();\n```",
  );
});

test("Explain kept as it is, closed with Escape, still goes to the agent", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  select(editor(), [0, 0], [2, 1]);
  await userEvent.click(within(await bar()).getByRole("button", { name: "Explain" }));
  await screen.findByRole("dialog", { name: "Annotation 1" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(chip()?.textContent).toBe("1 annotation");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(sent[0]).toContain("[1] src/retry.ts:1-3");
  expect(sent[0]).toContain("Intent: explain. Explain what this code does; leave it as it is.");
  expect(sent[0]).toContain("Comment: Explain what this does.");
});

test("Ask about this waits for the question, and nothing is kept without one", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  select(editor(), [1, 2], [1, 14]);
  fireEvent.contextMenu(document.querySelector("[data-editor-scroller]") ?? document.body, {
    clientX: 40,
    clientY: 30,
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Ask about this" }));

  let popover = await screen.findByRole("dialog", { name: "New annotation" });
  expect(pressed(popover)).toEqual(["Ask"]);
  expect(within(popover).getByPlaceholderText("Ask a question…")).toBeTruthy();
  const save = within(popover).getByRole("button", { name: "Save" });
  expect(save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true").toBe(true);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(chip()).toBeNull();

  select(editor(), [1, 2], [1, 14]);
  await userEvent.click(within(await bar()).getByRole("button", { name: "Ask about this" }));
  popover = await screen.findByRole("dialog", { name: "New annotation" });
  await userEvent.type(
    within(popover).getByRole("textbox", { name: "Comment" }),
    "Can this spin forever?{Enter}",
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(sent[0]).toContain(
    "Intent: question. Answer it; leave the code as it is.\nComment: Can this spin forever?",
  );
});

test("what the person wants can be changed later, or made a plain note", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  select(editor(), [1, 2], [1, 27]);
  await userEvent.click(within(await bar()).getByRole("button", { name: "Fix this" }));
  const popover = await screen.findByRole("dialog", { name: "Annotation 1" });
  await userEvent.click(within(popover).getByRole("button", { name: "Note" }));
  await userEvent.click(within(popover).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(sent[0]).not.toContain("Intent:");
  expect(sent[0]).toContain("Comment: Fix this.");
});

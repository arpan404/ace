import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { markers, openThread, select } from "./test/annotate-thread.tsx";

/*
 * Markers stay on their code while it changes: typing above or inside a range, deleting it, an
 * agent rewriting the file, the file changing while no editor had it open. Code that is gone is
 * outdated where it was; a marker never lands on other lines.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const path = "src/total.ts";
const source = [
  "import { Item } from './item';",
  "",
  "export function total(items: Item[]) {",
  "  return items.reduce((sum, item) => sum + item.price, 0);",
  "}",
].join("\n");

async function annotateLine(handle: Parameters<typeof select>[0], line: number, comment: string) {
  select(handle, [line, 2], [line, 58]);
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  await userEvent.type(within(popover).getByRole("textbox", { name: "Comment" }), comment);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const send = async (sent: string[]) => {
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  return sent.at(-1) ?? "";
};

test("lines typed above an annotation carry its marker and its reference down with its code", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  await annotateLine(editor(), 3, "Round the total");
  expect(markers()).toEqual(["1@4"]);

  select(editor(), [1, 0], [1, 0]);
  await userEvent.keyboard("{Enter}{Enter}const tax = 0.2;");
  await waitFor(() => expect(markers()).toEqual(["1@6"]));

  const text = await send(sent);
  expect(text).toContain(`[1] ${path}:6`);
  expect(text).toContain("return items.reduce((sum, item) => sum + item.price, 0);");
});

test("typing inside the range keeps it, and the agent reads the code as it is now", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  await annotateLine(editor(), 3, "Round the total");
  select(editor(), [3, 57], [3, 57]);
  await userEvent.keyboard(" * 100");
  const text = await send(sent);
  expect(text).toContain("return items.reduce((sum, item) => sum + item.price, 0) * 100;");
});

test("deleting the annotated code marks it outdated where it was, never on another line", async () => {
  const { editor, sent } = await openThread([{ path, text: source }]);
  await annotateLine(editor(), 3, "Round the total");
  select(editor(), [2, 0], [4, 1]);
  await userEvent.keyboard("{Backspace}");
  await waitFor(() => expect(markers()).toEqual(["1@3 outdated"]));
  // No wash: there is no code left to cover.
  expect(document.querySelectorAll("[data-annotated-range]")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Annotation 1, outdated, line 3" })).toBeTruthy();

  const text = await send(sent);
  expect(text).toContain(`[1] ${path}:3 (outdated)`);
  // What it pointed at is still there for the agent to recognise.
  expect(text).toContain("return items.reduce((sum, item) => sum + item.price, 0);");
});

test("an agent's rewrite moves an untouched range with its code and outdates a changed one", async () => {
  const { editor, rerender } = await openThread([{ path, text: source }]);
  await annotateLine(editor(), 3, "Round the total");

  const header = ["// Totals for the cart.", "// Prices are in cents."];
  rerender([{ path, text: [...header, source].join("\n") }]);
  await waitFor(() => expect(markers()).toEqual(["1@6"]));

  const changed = [...header, source.replace("item.price, 0)", "item.cost, 0)")].join("\n");
  rerender([{ path, text: changed }]);
  await waitFor(() => expect(markers()).toEqual(["1@6 outdated"]));
});

test("a file changed while it was closed: its code is found where it moved, or outdated", async () => {
  const first = await openThread([
    { path, text: source },
    { path: "src/other.ts", text: "export const one = 1;\nexport const two = 2;" },
  ]);
  await annotateLine(first.editor(), 3, "Round the total");
  select(first.editor("src/other.ts"), [1, 0], [1, 21]);
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  await userEvent.type(await screen.findByRole("textbox", { name: "Comment" }), "Drop it");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const draft = first.drafts.at(-1);
  first.unmount();

  const second = await openThread(
    [
      { path, text: `// moved\n\n${source}` },
      { path: "src/other.ts", text: "export const one = 1;" },
    ],
    draft,
  );
  const [moved, gone] = [...second.container.querySelectorAll<HTMLElement>('[role="region"]')];
  if (!moved || !gone) throw new Error("Two editors expected");
  await waitFor(() => expect(markers(moved)).toEqual(["1@6"]));
  await waitFor(() => expect(markers(gone)).toEqual(["2@1 outdated"]));
});

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { markers, openThread, select } from "./test/annotate-thread.tsx";

/*
 * Views the person can't type into take annotations too: a file's preview, and either side of
 * a diff. A diff's old side keeps its own annotations, told to the agent as the file before the
 * change.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const before = ["const limit = 3;", "export function retry() {}"].join("\n");
const after = ["const limit = 5;", "export function retry() {}"].join("\n");

async function annotate(comment: string) {
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  await userEvent.type(within(popover).getByRole("textbox", { name: "Comment" }), comment);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

test("a read-only preview takes annotations as the editor does, and its text stays as it was", async () => {
  const { editor } = await openThread([{ path: "src/limit.ts", text: after, readOnly: true }]);
  select(editor(), [0, 6], [0, 11]);
  const bar = await screen.findByRole("toolbar", { name: "Annotate selection" });
  await userEvent.click(within(bar).getByRole("button", { name: "Annotate" }));
  await userEvent.type(
    within(await screen.findByRole("dialog", { name: "New annotation" })).getByRole("textbox", {
      name: "Comment",
    }),
    "Why five?{Enter}",
  );
  await waitFor(() => expect(markers()).toEqual(["1@1"]));
  expect(editor().text()).toBe(after);
});

test("a diff's old side keeps its own annotations, and the agent reads them as the file before the change", async () => {
  const { editor, container, sent } = await openThread([
    { path: "src/limit.ts", text: before, readOnly: true, side: "old" },
    { path: "src/limit.ts", text: after, readOnly: true },
  ]);
  const [old, now] = [...container.querySelectorAll<HTMLElement>('[role="region"]')];
  if (!old || !now) throw new Error("Both sides expected");
  select(editor("src/limit.ts#old"), [0, 0], [0, 16]);
  await annotate("Three was right");
  select(editor("src/limit.ts"), [1, 0], [1, 6]);
  await annotate("Keep exported");
  // Each side shows its own; the number follows the draft's order.
  expect(markers(old)).toEqual(["1@1"]);
  expect(markers(now)).toEqual(["2@2"]);

  await userEvent.click(screen.getByRole("button", { name: "Show 2 annotations" }));
  const list = await screen.findByRole("list", { name: "Annotations" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent?.includes("Before the change"))).toEqual([true, false]);
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(sent[0]).toContain(
    "[1] src/limit.ts:1\nSelection: line 1 column 1 to line 1 column 17\nVersion: the file before the change being reviewed",
  );
  expect(sent[0]).toContain(
    "[2] src/limit.ts:2\nSelection: line 2 column 1 to line 2 column 7\nComment:",
  );
});

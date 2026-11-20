import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openExplorer, row, threadId } from "./explorer-test-support.ts";
import { revealInExplorer } from "./file-tree-editor.ts";

configure({ asyncUtilTimeout: 10000 });

const socket = "apps/web/src/relay/socket.ts";

// jsdom lays nothing out: record which rows were asked to scroll into view instead.
const scrolled: string[] = [];
const original = Element.prototype.scrollIntoView;
beforeEach(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-path") ?? "");
  };
});
afterEach(() => {
  Element.prototype.scrollIntoView = original;
  scrolled.length = 0;
});

async function quickOpen(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
}

const tree = (panel: HTMLElement) => within(panel).getByRole("tree", { name: "Checkout files" });

test("a file opened from quick open is revealed in the explorer: folders open, row selected and scrolled to", async () => {
  const { panel } = await openExplorer();
  await quickOpen("socket.ts");
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  const found = await row(tree(panel), socket);
  await waitFor(() => expect(found.getAttribute("aria-selected")).toBe("true"));
  expect(scrolled).toContain(socket);
  // Revealing doesn't take the keyboard: nothing in the tree holds focus.
  expect(tree(panel).contains(document.activeElement)).toBe(false);
});

test("with following turned off the tree stays as it was, and an explicit reveal still shows the file", async () => {
  const { panel, tree: files } = await openExplorer();
  const empty = files.parentElement?.querySelector<HTMLElement>('[data-part="tree-root"]');
  await userEvent.pointer({ target: empty as HTMLElement, keys: "[MouseRight]" });
  const follow = await screen.findByRole("menuitemcheckbox", { name: "Follow the open file" });
  expect(follow.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(follow);
  await quickOpen("socket.ts");
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  const shown = tree(panel);
  await within(shown).findByRole("treeitem", { name: "README.md" });
  expect(shown.querySelector(`[data-path="${socket}"]`)).toBeNull();
  expect(within(shown).getByRole("treeitem", { name: "apps" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  act(() => revealInExplorer(threadId, socket));
  const found = await row(shown, socket);
  await waitFor(() => expect(found.getAttribute("aria-selected")).toBe("true"));
  expect(scrolled).toContain(socket);
});

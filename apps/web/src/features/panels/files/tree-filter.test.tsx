import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { expand, renderTree, row } from "./tree-test-support.tsx";
import { threadId } from "./tree-test-queries.ts";

configure({ asyncUtilTimeout: 10000 });

/** The tree's filter field, beside the tree in its panel. */
function filterOf(tree: HTMLElement) {
  const panel = tree.closest("section");
  if (!panel) throw new Error("no panel");
  return within(panel).getByRole("searchbox", { name: "Find files in the checkout" });
}

async function matches(tree: HTMLElement) {
  const panel = tree.closest("section");
  if (!panel) throw new Error("no panel");
  return within(panel).findByRole("listbox", { name: "Matching files" });
}

/** The listed matches' names, in order, as a screen reader reads each option. */
const names = (list: HTMLElement) =>
  within(list)
    .queryAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));

test("the filter lists matches flat, an exact or prefix name first, each with its folder", async () => {
  const { daemon, tree } = await renderTree();
  daemon.checkouts.seed(threadId, "apps/web/src/relay/deep/box.ts", "export {};\n");
  await userEvent.type(filterOf(tree), "box.ts");
  const list = await matches(tree);
  // The exact name beats a shorter path that only contains it; no folder rows in between.
  await waitFor(() =>
    expect(names(list)).toEqual([
      "box.ts, apps/web/src/relay/deep",
      "outbox.ts, apps/web/src/relay",
    ]),
  );
  // The name shows whole and first; the folder follows it in its own part.
  const [first] = within(list).getAllByRole("option");
  if (!first) throw new Error("no option");
  expect(first.querySelector("[data-part='match-name']")?.textContent).toBe("box.ts");
  expect(first.querySelector("[data-part='match-folder']")?.textContent).toBe(
    "apps/web/src/relay/deep",
  );
  expect(first.getAttribute("title")).toBe("apps/web/src/relay/deep/box.ts");
});

test("Enter in the filter keeps the top match open; the arrows move to the next one", async () => {
  const { daemon, tree, outputs } = await renderTree();
  daemon.checkouts.seed(threadId, "apps/web/src/relay/deep/box.ts", "export {};\n");
  const filter = filterOf(tree);
  await userEvent.type(filter, "box");
  const list = await matches(tree);
  await waitFor(() => expect(names(list)).toHaveLength(2));
  await userEvent.keyboard("{Enter}");
  expect(outputs.opened.at(-1)).toEqual({ path: "apps/web/src/relay/deep/box.ts", how: "keep" });

  await userEvent.keyboard("{ArrowDown}");
  const [, second] = within(list).getAllByRole("option");
  expect(second?.getAttribute("aria-selected")).toBe("true");
  expect(filter.getAttribute("aria-activedescendant")).toBe(second?.id);
  // The keyboard stays in the field while the arrows move.
  expect(document.activeElement).toBe(filter);
  await userEvent.keyboard("{Enter}");
  expect(outputs.opened.at(-1)).toEqual({ path: "apps/web/src/relay/outbox.ts", how: "keep" });
});

test("a click on a match opens it as a glance, and clearing the filter brings the tree back", async () => {
  const { tree, outputs } = await renderTree();
  await userEvent.type(filterOf(tree), "socket");
  const list = await matches(tree);
  await userEvent.click(await within(list).findByRole("option", { name: /^socket\.ts/ }));
  expect(outputs.opened.at(-1)).toEqual({ path: "apps/web/src/relay/socket.ts", how: "preview" });
  await userEvent.clear(filterOf(tree));
  const panel = tree.closest("section");
  if (!panel) throw new Error("no panel");
  expect(await within(panel).findByRole("tree", { name: "Checkout files" })).toBeTruthy();
});

test("a long name is cut at its end, keeping its extension, and its tooltip holds the whole path", async () => {
  const { daemon, tree } = await renderTree();
  const path = "apps/web/src/relay/pull-request-tabs-strip.tsx";
  daemon.checkouts.seed(threadId, path, "export {};\n");
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  const long = await row(tree, path);
  expect(long.getAttribute("title")).toBe(path);
  // The part that never shrinks is the extension: "pull-request-tabs-st….tsx".
  expect(long.querySelector("[data-part='name-end']")?.textContent).toBe(".tsx");
  expect(long.textContent).toBe("pull-request-tabs-strip.tsx");
});

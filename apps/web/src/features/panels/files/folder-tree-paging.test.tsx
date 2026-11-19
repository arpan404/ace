import { coldStartReplay } from "@ace/fake-daemon";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { useScrollLayout } from "@/test/scroll-layout.ts";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });
// A tree's rows are 32px; a folder of 500 entries runs past the view, as it would in a browser.
useScrollLayout({ viewport: 600, row: 32 });

const thread = "thread-cold-start";

/** Scroll the tree to its end, as the person does before Show more. */
function scrollToEnd(tree: HTMLElement) {
  const viewport = tree.parentElement;
  if (!viewport) throw new Error("The tree has no scroller");
  act(() => {
    viewport.scrollTop = 10_000_000;
    viewport.dispatchEvent(new Event("scroll"));
  });
}

/** Files with a folder of 505 entries open in the panel, ready to page. */
async function openBig() {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  for (let n = 0; n < 505; n++)
    app.daemon.checkouts.seed(thread, `big/entry-${String(n).padStart(4, "0")}.txt`, "x\n");
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Files/ }));
  const tree = await within(panel).findByRole("tree", { name: "Checkout files" });
  await userEvent.click(await within(tree).findByRole("treeitem", { name: "big" }));
  await within(tree).findByRole("treeitem", { name: "entry-0000.txt" });
  return { folders, tree };
}

test("a big folder loads its next page when its last rows scroll into view, with no click", async () => {
  const { folders, tree } = await openBig();
  expect(folders.count("big")).toBe(1);
  scrollToEnd(tree);
  await waitFor(() => expect(folders.count("big")).toBe(2));
  scrollToEnd(tree);
  expect(await within(tree).findByRole("treeitem", { name: "entry-0504.txt" })).toBeTruthy();
  expect(within(tree).queryByRole("treeitem", { name: "Show more" })).toBeNull();
});

test("a failed page stops loading and retries with its cursor on Try again", async () => {
  const { folders, tree } = await openBig();
  folders.failNext("big", "IO_ERROR");
  scrollToEnd(tree);
  const retry = await within(tree).findByRole("button", { name: "Try again" });
  await waitFor(() => expect(folders.count("big")).toBe(2));
  // A failed page is not asked for again until the person retries.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(folders.count("big")).toBe(2);
  await userEvent.click(retry);
  await waitFor(() => expect(folders.count("big")).toBe(3));
  const requests = folders.requests.filter((request) => request.path === "big");
  expect(requests.at(-1)?.cursor).toBe("500");
  scrollToEnd(tree);
  expect(await within(tree).findByRole("treeitem", { name: "entry-0504.txt" })).toBeTruthy();
});

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

test("a big folder pages with Show more, and the last entry follows", async () => {
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

  // The first page is 500 entries, so the folder offers the rest at its end.
  scrollToEnd(tree);
  const more = await within(tree).findByRole("treeitem", { name: "Show more" });
  await userEvent.click(more);
  await waitFor(() => expect(folders.count("big")).toBe(2));
  expect(within(tree).queryByRole("treeitem", { name: "Show more" })).toBeNull();
  scrollToEnd(tree);
  expect(await within(tree).findByRole("treeitem", { name: "entry-0504.txt" })).toBeTruthy();
});

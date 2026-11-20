import { coldStartReplay } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";
import { threadId } from "./tree-test-queries.ts";

export { bytes, expand, menuPick, row, threadId } from "./tree-test-queries.ts";

/*
 * The Files explorer's tests open the cold-start thread's Files tab and drive its tree as a
 * person does. Its checkout holds README.md, apps/web/src/relay/{outbox,replay,socket}.ts and
 * more, from the fake daemon.
 */

export async function openExplorer(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  const folders = folderFixture(app.client, threadId);
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Editor/ }));
  await within(panel).findByRole("tab", { name: "Editor", selected: true });
  const tree = await within(panel).findByRole("tree", { name: "Checkout files" });
  await within(tree).findByRole("treeitem", { name: "README.md" });
  return { app, panel, tree, folders };
}

/** The names of the panel's tabs, in strip order. */
export function tabNames(panel: HTMLElement) {
  return within(panel)
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
}

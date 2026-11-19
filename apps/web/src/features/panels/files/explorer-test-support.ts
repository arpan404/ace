import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

/*
 * The Files explorer's tests open the cold-start thread's Files tab and drive its tree as a
 * person does. Its checkout holds README.md, apps/web/src/relay/{outbox,replay,socket}.ts and
 * more, from the fake daemon.
 */

export const threadId = ThreadId.parse("thread-cold-start");

export async function openExplorer() {
  const app = harness();
  const folders = folderFixture(app.client, threadId);
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Files/ }));
  await within(panel).findByRole("tab", { name: "Files", selected: true });
  const tree = await within(panel).findByRole("tree", { name: "Checkout files" });
  await within(tree).findByRole("treeitem", { name: "README.md" });
  return { app, panel, tree, folders };
}

/** A tree row by its checkout path ("apps/" for a folder), once it is listed. */
export function row(tree: HTMLElement, path: string) {
  return waitFor(() => {
    const found = tree.querySelector<HTMLElement>(`[data-path="${path}"]`);
    if (!found) throw new Error(`${path} is not listed yet`);
    return found;
  });
}

/** Open each folder of `folders` in order, so what's inside them shows. */
export async function expand(tree: HTMLElement, folders: readonly string[]) {
  for (const folder of folders) {
    const found = await row(tree, folder);
    if (found.getAttribute("aria-expanded") !== "true") await userEvent.click(found);
    await waitFor(() => expect(found.getAttribute("aria-expanded")).toBe("true"));
  }
}

/** Right-click `target` and pick `item` (a name or pattern) from its menu. */
export async function menuPick(target: HTMLElement, item: string | RegExp) {
  await userEvent.pointer({ target, keys: "[MouseRight]" });
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** A checkout file's bytes as text, straight from the fake daemon. */
export async function bytes(app: ReturnType<typeof harness>, path: string) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of app.client.downloadFile({ threadId, op: "download", path, offset: 0 }))
    chunks.push(new Uint8Array(chunk));
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** The names of the panel's tabs, in strip order. */
export function tabNames(panel: HTMLElement) {
  return within(panel)
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
}

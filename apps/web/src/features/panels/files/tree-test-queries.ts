import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

/* Queries and gestures on the cold-start thread's Files tree, rendered alone or in the app. */

export const threadId = ThreadId.parse("thread-cold-start");

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
export async function bytes(app: { client: ClientApi }, path: string) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of app.client.downloadFile({ threadId, op: "download", path, offset: 0 }))
    chunks.push(new Uint8Array(chunk));
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const threadId = ThreadId.parse("thread-cold-start");
const path = "apps/web/src/relay/socket.ts";

/** ⌘P to socket.ts: it opens in the Deck, always editable, with the keyboard in it. */
async function openEditor() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });

  await userEvent.keyboard("{Control>}p{/Control}");
  const search = await screen.findByRole("combobox", { name: "Search files" });
  await userEvent.type(search, "socket");
  await userEvent.keyboard("{Enter}");

  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const tab = await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  const box = await within(panel).findByRole("textbox", { name: "socket.ts" });
  await userEvent.click(box);
  return { app, panel, box, tab };
}

async function readCheckout(app: ReturnType<typeof harness>, file: string) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of app.client.downloadFile({
    threadId,
    op: "download",
    path: file,
    offset: 0,
  }))
    chunks.push(chunk);
  return new TextDecoder().decode(
    await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).arrayBuffer(),
  );
}

async function versionOf(app: ReturnType<typeof harness>) {
  const stat = await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "stat", path },
  });
  if (
    stat.type !== "files.result" ||
    typeof stat.value !== "object" ||
    stat.value === null ||
    !("version" in stat.value) ||
    typeof stat.value.version !== "string"
  )
    throw new Error("Missing the file's version");
  return stat.value.version;
}

const slot = (tab: HTMLElement) => tab.querySelector<HTMLElement>("[data-shows]")?.dataset.shows;

test("⌘S saves an edit in place; a file changed elsewhere asks before it is replaced", async () => {
  const { app, panel, box, tab } = await openEditor();

  await userEvent.keyboard("{Control>}a{/Control}");
  await userEvent.keyboard("// edited by the test");
  // Unsaved shows as the tab's dot, and nowhere else in the editor.
  await waitFor(() => expect(slot(tab)).toBe("unsaved"));
  expect(within(panel).queryByText("Unsaved changes")).toBeNull();
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(async () => expect(await readCheckout(app, path)).toBe("// edited by the test"));
  await waitFor(() => expect(slot(tab)).not.toBe("unsaved"));
  // Saving changes no mode: the same editor keeps the keyboard.
  expect(box.isConnected).toBe(true);
  expect(document.activeElement).toBe(box);

  // Edit again, and the file changes behind the editor's back.
  await userEvent.keyboard("{End}!");
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "write", path, expected: await versionOf(app), text: "a newer version" },
  });

  await userEvent.keyboard("{Control>}s{/Control}");
  const dialog = await screen.findByRole("dialog", {
    name: "socket.ts changed on disk. Replace it?",
  });
  expect(await readCheckout(app, path)).toBe("a newer version");
  await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
  await waitFor(async () => expect(await readCheckout(app, path)).toBe("// edited by the test!"));
});

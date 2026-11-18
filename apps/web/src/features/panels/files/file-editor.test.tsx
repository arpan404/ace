import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const threadId = ThreadId.parse("thread-cold-start");
const path = "apps/web/src/relay/socket.ts";

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
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  await userEvent.click(within(panel).getByRole("button", { name: "Edit file" }));
  const box = await within(panel).findByRole("textbox", { name: "socket.ts" });
  await userEvent.click(box);
  return { app, panel, box };
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

test("the toolbar's wrap button stays available while the file is open in the editor", async () => {
  const { panel } = await openEditor();

  const wrap = within(panel).getByRole("button", { name: "Wrap lines" });
  expect((wrap as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(wrap);

  await within(panel).findByRole("button", { name: "Don't wrap lines" });
});

test("saving an edit writes it, and a file changed elsewhere asks before it is replaced", async () => {
  const { app, panel, box } = await openEditor();

  await userEvent.keyboard("{Control>}a{/Control}");
  await userEvent.keyboard("// edited by the test");
  expect(within(panel).getByText("Unsaved changes")).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
  await waitFor(async () => expect(await readCheckout(app, path)).toBe("// edited by the test"));
  await within(panel).findByRole("region", { name: `Source of ${path}` });

  // Open it again and change the file behind the editor's back.
  await userEvent.click(within(panel).getByRole("button", { name: "Edit file" }));
  const again = await within(panel).findByRole("textbox", { name: "socket.ts" });
  await userEvent.click(again);
  await userEvent.keyboard("{End}");
  await userEvent.keyboard("!");
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "write", path, expected: await versionOf(app), text: "a newer version" },
  });

  await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
  expect(await within(panel).findByText(/changed since you opened it. Replace it\?/)).toBeTruthy();
  expect(await readCheckout(app, path)).toBe("a newer version");

  await userEvent.click(within(panel).getByRole("button", { name: "Replace" }));
  await waitFor(async () => expect(await readCheckout(app, path)).toBe("// edited by the test!"));
  const boxAfter = await within(panel).findByRole("region", { name: `Source of ${path}` });
  expect(await within(boxAfter).findByText(/edited by the test/)).toBeTruthy();
  expect(box.isConnected).toBe(false);
});

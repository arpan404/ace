import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "../../files/folders-test-support.ts";

/*
 * Source control rewrites files on disk (discard, switch, pull); it never touches an open
 * editor's unsaved text. The person's buffer survives every one of them, even when the file goes.
 */

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";
const path = "src/app.ts";

test("an unsaved buffer survives a discard, a branch switch and a pull that deletes its file", async () => {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("root-replied");
  app.daemon.checkouts.seed(thread, path, "export const version = 2;\n");
  app.daemon.workspace.setSourceControl(thread, {
    branch: "feat/buffers",
    branches: ["main", "feat/buffers"],
    refs: [{ name: "main" }, { name: "feat/buffers" }],
    behind: 1,
    unstaged: [{ path, status: "modified" }],
  });
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "app.ts");
  await screen.findByRole("option", { name: /app\.ts/ });
  await userEvent.keyboard("{Enter}");
  const side = await screen.findByRole("region", { name: "Thread panel" });
  const editor = await within(side).findByRole("textbox", { name: "app.ts" });
  await waitFor(() => expect(folders.watches.at(-1)).toContain("src"));
  editor.focus();
  await userEvent.keyboard("mine ");
  const source = () =>
    within(side).getByRole("region", { name: `Source of ${path}` }).textContent ?? "";
  await waitFor(() => expect(source()).toContain("mine export"));

  await userEvent.click(within(side).getByRole("button", { name: "Source control" }));
  const explorer = await within(side).findByRole("complementary", { name: "Explorer" });

  // Discard: the file on disk goes back; the buffer keeps the person's text.
  await userEvent.click(await within(explorer).findByRole("button", { name: "Discard app.ts" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }),
  );
  await within(explorer).findByText("No changes in this checkout.");
  app.daemon.checkouts.overwrite(thread, path, "export const version = 1;\n");
  folders.changed(["src"]);
  await within(side).findByText(/changed on disk|also changed this file/);
  expect(source()).toContain("mine export const version = 2;");

  // Switching branches rewrites it again; the buffer still holds the edit.
  await userEvent.click(within(explorer).getByRole("button", { name: "Branch: feat/buffers" }));
  await userEvent.click(await screen.findByRole("button", { name: "main" }));
  await within(explorer).findByRole("button", { name: "Branch: main" });
  app.daemon.checkouts.overwrite(thread, path, "export const version = 0;\n");
  folders.changed(["src"]);
  await waitFor(() => expect(source()).toContain("mine export const version = 2;"));

  // A pull deletes the file. The editor drops the "changed on disk" notice (there is nothing on
  // disk to compare with) and keeps the unsaved text, ready to save the file again.
  await userEvent.click(within(explorer).getByRole("button", { name: "Pull (1 behind)" }));
  await within(explorer).findByRole("button", { name: "Pull" });
  app.daemon.checkouts.vanish(thread, path);
  folders.changed(["src"]);
  await waitFor(() =>
    expect(within(side).queryByText(/changed on disk|also changed this file/)).toBeNull(),
  );
  expect(await readBack(app)).toBe("");
  expect(source()).toContain("mine export const version = 2;");
});

/** The file as it is on disk now; empty once it is gone. */
async function readBack(app: ReturnType<typeof harness>): Promise<string> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of app.client.downloadFile({
      threadId: ThreadId.parse(thread),
      op: "download",
      path,
      offset: 0,
    }))
      chunks.push(chunk);
  } catch {
    return "";
  }
  return new TextDecoder().decode(
    await new Blob(chunks.map((c) => new Uint8Array(c))).arrayBuffer(),
  );
}

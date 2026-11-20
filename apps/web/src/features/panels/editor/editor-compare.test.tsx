import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "../files/folders-test-support.ts";

/*
 * Spec 46: an agent writes a file the person is editing. Compare shows what is on disk beside
 * the unsaved buffer, and answers it there: Merge (both changes), Keep mine (the buffer stays,
 * ready to save over theirs) or Take theirs (the edits go).
 */

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";
const path = "notes/plan.ts";

async function clashed() {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  app.daemon.checkouts.seed(thread, path, "one\ntwo\nthree\nfour\n");
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "plan.ts");
  await screen.findByRole("option", { name: /plan\.ts/ });
  await userEvent.keyboard("{Enter}");
  const side = await screen.findByRole("region", { name: "Thread panel" });
  const editor = await within(side).findByRole("textbox", { name: "plan.ts" });
  await waitFor(() => expect(folders.watches.at(-1)).toContain("notes"));
  editor.focus();
  await userEvent.keyboard("mine ");
  await within(side).findByRole("tab", { name: /plan\.ts/ });
  app.daemon.checkouts.overwrite(thread, path, "one\ntwo\nthree\nfour\nagent\n");
  folders.changed(["notes"]);
  await within(side).findByText(/changed on disk|also changed this file/);
  return { app, side };
}

const source = (side: HTMLElement) =>
  within(side).getByRole("region", { name: `Source of ${path}` }).textContent ?? "";

test("Compare shows the disk's text beside the unsaved buffer; Take theirs drops the edits", async () => {
  const { side } = await clashed();
  await userEvent.click(within(side).getByRole("button", { name: "Compare" }));
  const compare = await within(side).findByRole("region", { name: `Compare ${path}` });
  expect(within(compare).getByText("On disk")).toBeTruthy();
  expect(within(compare).getByText("Your changes")).toBeTruthy();
  await waitFor(() => {
    expect(compare.textContent).toContain("agent");
    expect(compare.textContent).toContain("mine one");
  });

  await userEvent.click(within(side).getByRole("button", { name: "Take theirs" }));
  await waitFor(() =>
    expect(within(side).queryByRole("region", { name: `Compare ${path}` })).toBeNull(),
  );
  await waitFor(() => expect(source(side)).toContain("agent"));
  expect(source(side)).not.toContain("mine");
  expect(within(side).queryByText(/also changed this file|changed on disk/)).toBeNull();
});

test("Keep mine from Compare keeps the edits, and saving writes them over the agent's", async () => {
  const { app, side } = await clashed();
  await userEvent.click(within(side).getByRole("button", { name: "Compare" }));
  await within(side).findByRole("region", { name: `Compare ${path}` });
  await userEvent.click(within(side).getByRole("button", { name: "Keep mine" }));
  await waitFor(() => expect(source(side)).toContain("mine one"));
  expect(within(side).queryByText(/also changed this file|changed on disk/)).toBeNull();

  within(side).getByRole("textbox", { name: "plan.ts" }).focus();
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(async () => expect(await readBack(app)).toBe("mine one\ntwo\nthree\nfour\n"));
});

test("Merge from Compare keeps both changes", async () => {
  const { side } = await clashed();
  await userEvent.click(within(side).getByRole("button", { name: "Compare" }));
  await within(side).findByRole("region", { name: `Compare ${path}` });
  await userEvent.click(within(side).getByRole("button", { name: "Merge" }));
  await waitFor(() => {
    expect(source(side)).toContain("mine one");
    expect(source(side)).toContain("agent");
  });
});

async function readBack(app: ReturnType<typeof harness>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of app.client.downloadFile({
    threadId: ThreadId.parse(thread),
    op: "download",
    path,
    offset: 0,
  }))
    chunks.push(chunk);
  return new TextDecoder().decode(
    await new Blob(chunks.map((c) => new Uint8Array(c))).arrayBuffer(),
  );
}

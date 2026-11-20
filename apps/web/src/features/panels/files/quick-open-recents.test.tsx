import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

async function openThread() {
  const app = harness();
  folderFixture(app.client, "thread-cold-start");
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });

/** ⌘P, type `text`, Enter on the first match once it is listed. */
async function pick(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
  await within(await panel()).findByRole("tab", { name: text, selected: true });
}

test("quick open's empty list leads with open editors, then files agents changed, then recent files", async () => {
  await openThread();
  await pick("README.md");
  await pick("socket.ts");
  await pick("outbox.ts");
  // README.md is closed again: it stays a recent file, no longer an open one.
  const side = await panel();
  await userEvent.click(within(side).getByRole("tab", { name: "README.md" }));
  await userEvent.keyboard("{Alt>}{Control>}w{/Control}{/Alt}");
  await waitFor(() => expect(within(side).queryByRole("tab", { name: "README.md" })).toBeNull());
  await userEvent.click(within(side).getByRole("tab", { name: "outbox.ts" }));

  await userEvent.keyboard("{Control>}p{/Control}");
  const list = await screen.findByRole("listbox", { name: "Files" });
  const names = within(list)
    .getAllByRole("option")
    .map((option) => option.querySelector("span")?.textContent);
  // Open editors, the showing one first: outbox.ts, then socket.ts. Then the thread's edits
  // not already listed (replay.ts), then what was opened before (README.md). No narration.
  expect(names).toEqual(["outbox.ts", "socket.ts", "replay.ts", "README.md"]);
  expect(within(list).getByText("Open editors")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

test("after quick open opens a file, the keyboard is in the file, not back in the composer", async () => {
  await openThread();
  (await screen.findByLabelText("Message")).focus();
  await pick("socket.ts");
  const source = await within(await panel()).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.contains(document.activeElement)).toBe(true));
});

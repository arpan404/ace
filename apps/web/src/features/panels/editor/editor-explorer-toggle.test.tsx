import { coldStartReplay } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * The explorer is hidden and shown by one switch in every layout: Hide files in its header,
 * Show files in the strip while it's hidden, and ⌘B (Ctrl+B off Apple) from inside the editor.
 * The choice is the thread's, so a reload keeps it.
 */

async function openThread(storage: ReturnType<typeof memoryKeyValue>) {
  const app = harness({ storage });
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });
const explorer = async () =>
  within(await panel()).queryByRole("complementary", { name: "Explorer" });

async function openFile(name: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), name);
  await screen.findByRole("option", { name: new RegExp(name.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
  await within(await panel()).findByRole("tab", { name, selected: true });
}

test("Hide files and Show files put the explorer away and back, and a reload keeps the choice", async () => {
  const storage = memoryKeyValue();
  await openThread(storage);
  await openFile("socket.ts");
  expect(await explorer()).not.toBeNull();

  await userEvent.click(within(await panel()).getByRole("button", { name: "Hide files" }));
  await waitFor(async () => expect(await explorer()).toBeNull());

  cleanup();
  await openThread(storage);
  await within(await panel()).findByRole("tab", { name: "socket.ts" });
  expect(await explorer()).toBeNull();
  await userEvent.click(within(await panel()).getByRole("button", { name: "Show files" }));
  await waitFor(async () => expect(await explorer()).not.toBeNull());
  expect(within(await panel()).queryByRole("button", { name: "Show files" })).toBeNull();
});

test("⌘B in the editor hides and shows the explorer", async () => {
  await openThread(memoryKeyValue());
  await openFile("outbox.ts");
  const code = await within(await panel()).findByRole("textbox", { name: "outbox.ts" });
  code.focus();
  // ⌘B off Apple (the test platform) is Ctrl+B.
  await userEvent.keyboard("{Control>}b{/Control}");
  await waitFor(async () => expect(await explorer()).toBeNull());
  within(await panel())
    .getByRole("textbox", { name: "outbox.ts" })
    .focus();
  await userEvent.keyboard("{Control>}b{/Control}");
  await waitFor(async () => expect(await explorer()).not.toBeNull());
});

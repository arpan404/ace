import { coldStartReplay } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * Spec 52, 54: the editor's layout (its groups, their tabs, which shows) is local UI state kept
 * with the workspace store, so a reload of the window brings it back as it was.
 */

async function openThread(storage: ReturnType<typeof memoryKeyValue>) {
  const app = harness({ storage });
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });
const strips = async () =>
  (await within(await panel()).findAllByRole("tablist", { name: "Open files" })).map((strip) =>
    within(strip)
      .getAllByRole("tab")
      .map(
        (tab) =>
          `${tab.getAttribute("title")}${tab.getAttribute("aria-selected") === "true" ? " *" : ""}`,
      ),
  );

async function pick(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
  await within(await panel()).findByRole("tab", { name: text, selected: true });
}

test("a reload brings the editor back with its groups, tabs and shown files", async () => {
  const storage = memoryKeyValue();
  await openThread(storage);
  await pick("socket.ts");
  await pick("outbox.ts");
  // ⌥⌘\ off Apple is Ctrl+Alt+\: a second view of outbox.ts in a group to the right.
  const editor = await within(await panel()).findByRole("textbox", { name: "outbox.ts" });
  editor.focus();
  await userEvent.keyboard("{Control>}{Alt>}\\{/Alt}{/Control}");
  await waitFor(async () => expect(await strips()).toHaveLength(2));
  const before = await strips();
  expect(before).toEqual([
    ["apps/web/src/relay/socket.ts", "apps/web/src/relay/outbox.ts *"],
    ["apps/web/src/relay/outbox.ts *"],
  ]);

  cleanup();
  await openThread(storage);
  await waitFor(async () => expect(await strips()).toEqual(before));
});

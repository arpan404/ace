import { coldStartReplay } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * Spec 55: drafts carried over from old per-file tabs ride in the Deck's stored layout until the
 * draft store has them. The test runs without IndexedDB, so the import never succeeds, and the
 * drafts must survive every layout write meanwhile.
 */

const draft = {
  path: "apps/web/src/relay/socket.ts",
  text: "mine\n",
  original: "theirs\n",
  version: "v1",
};

/** The Deck tab's stored layout. */
function storedDeck(storage: ReturnType<typeof memoryKeyValue>): Record<string, unknown> {
  const workspace: unknown = JSON.parse(storage.getItem("ace.workspace") ?? "{}");
  const scopes: unknown = Reflect.get(Object(workspace), "scopes");
  const scope: unknown = Array.isArray(scopes) ? scopes[0]?.[1] : undefined;
  const tabs: unknown = Reflect.get(Object(scope), "tabs");
  const deck: unknown = Array.isArray(tabs)
    ? tabs.find((tab: unknown) => Reflect.get(Object(tab), "kind") === "deck")
    : undefined;
  return Object(Reflect.get(Object(deck), "data"));
}

/** Puts the carried drafts in the Deck's stored layout, as the migration leaves them. */
function carry(storage: ReturnType<typeof memoryKeyValue>) {
  const raw = storage.getItem("ace.workspace") ?? "";
  const data = JSON.stringify(storedDeck(storage));
  const carried = JSON.stringify({ ...storedDeck(storage), migratedDrafts: [draft] });
  storage.setItem("ace.workspace", raw.replace(data, carried));
}

async function openThread(storage: ReturnType<typeof memoryKeyValue>) {
  const app = harness({ storage });
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

async function pick(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("tab", { name: text, selected: true });
}

test("a layout change the Deck makes before the draft import lands keeps the carried drafts stored", async () => {
  const storage = memoryKeyValue();
  await openThread(storage);
  await pick("socket.ts");
  cleanup();
  carry(storage);
  expect(storedDeck(storage)["migratedDrafts"]).toEqual([draft]);

  await openThread(storage);
  await pick("outbox.ts");
  // A change the Deck writes itself: closing a tab from its strip.
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const strip = within(panel).getByRole("tablist", { name: "Open files" });
  await userEvent.click(within(strip).getByRole("button", { name: "Close outbox.ts" }));

  await waitFor(() =>
    expect(JSON.stringify(storedDeck(storage)["root"])).not.toContain("outbox.ts"),
  );
  expect(storedDeck(storage)["migratedDrafts"]).toEqual([draft]);
});

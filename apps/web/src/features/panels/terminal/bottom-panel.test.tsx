import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const coldStart = "Cap cold-start replay at 200 events";

/**
 * The cold-start thread with two shells of yours already running in the daemon (`tests` and
 * `zsh`, which ran git status). Terminals open in the bottom panel unless Settings say otherwise.
 */
async function openThread(storage = memoryKeyValue()) {
  const app = harness({ storage });
  app.play(coldStartReplay()).runThrough("turn-2");
  seedPanels(app.daemon);
  const view = await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: coldStart });
  return { app, view, storage };
}

const bottomPanel = () => screen.findByRole("region", { name: "Terminal panel" });
const noBottomPanel = () =>
  waitFor(() => expect(screen.queryByRole("region", { name: "Terminal panel" })).toBeNull());
const names = (app: ReturnType<typeof harness>) =>
  app.daemon.terminals.list("thread-cold-start").map((info) => info.name);
const composer = () => screen.findByRole("combobox", { name: "Message" });

test("⌘J shows the bottom terminal panel and focuses its terminal; again hides it and focus returns to the composer", async () => {
  const { app } = await openThread();
  (await composer()).focus();

  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await bottomPanel();
  // The thread's running zsh, under the conversation; the side panel stays shut.
  expect(await within(panel).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();
  const input = await within(panel).findByRole("textbox", { name: "zsh input" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await waitFor(() =>
    expect(within(panel).getByRole("log", { name: "zsh output" }).textContent).toContain(
      "M apps/server/src/replay.ts",
    ),
  );

  await userEvent.keyboard("{Meta>}j{/Meta}");
  await noBottomPanel();
  expect(document.activeElement).toBe(await composer());
  // Hiding keeps the shells.
  expect(names(app)).toEqual(["tests", "zsh"]);
});

test("⌃` toggles the same bottom panel, and its Hide button hides it", async () => {
  await openThread();
  await userEvent.keyboard("{Control>}`{/Control}");
  const panel = await bottomPanel();
  expect(await within(panel).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Hide terminal panel" }));
  await noBottomPanel();

  await userEvent.keyboard("{Control>}`{/Control}");
  expect(await within(await bottomPanel()).findByRole("tab", { name: "zsh" })).toBeTruthy();
});

test("the bottom panel's height and visibility are kept after a reload", async () => {
  const { view, storage } = await openThread();
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const handle = within(await bottomPanel()).getByRole("separator", {
    name: "Resize terminal panel",
  });
  const before = Number(handle.getAttribute("aria-valuenow"));
  handle.focus();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  const after = Number(handle.getAttribute("aria-valuenow"));
  expect(after).toBeGreaterThan(before);
  view.unmount();

  await openThread(storage);
  const restored = await bottomPanel();
  expect(
    within(restored)
      .getByRole("separator", { name: "Resize terminal panel" })
      .getAttribute("aria-valuenow"),
  ).toBe(String(after));
  expect(await within(restored).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
});

test("a terminal moved between panels keeps its shell and what it printed", async () => {
  const { app } = await openThread();
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await bottomPanel();
  await within(panel).findByRole("tab", { name: "zsh", selected: true });
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh input" }),
    "pwd{Enter}",
  );
  await waitFor(() =>
    expect(within(panel).getByRole("log", { name: "zsh output" }).textContent).toContain(
      "/Users/dev/ace",
    ),
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Terminal actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move to side panel" }));
  const side = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  await waitFor(() =>
    expect(within(side).getByRole("log", { name: "zsh output" }).textContent).toContain(
      "/Users/dev/ace",
    ),
  );
  // Its only terminal gone, the bottom panel hides; no second shell started.
  await noBottomPanel();
  expect(names(app)).toEqual(["tests", "zsh"]);

  await userEvent.click(within(side).getByRole("button", { name: "Terminal actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move to bottom panel" }));
  const back = await bottomPanel();
  expect(await within(back).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  await waitFor(() =>
    expect(within(back).getByRole("log", { name: "zsh output" }).textContent).toContain(
      "/Users/dev/ace",
    ),
  );
  expect(within(side).queryByRole("tab", { name: "zsh" })).toBeNull();
  expect(names(app)).toEqual(["tests", "zsh"]);
});

test("New terminal in the bottom panel opens another shell there, and closing its tab ends it", async () => {
  const { app } = await openThread();
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await bottomPanel();
  await within(panel).findByRole("tab", { name: "zsh", selected: true });

  await userEvent.click(within(panel).getByRole("button", { name: "New terminal" }));
  expect(await within(panel).findByRole("tab", { name: "zsh 2", selected: true })).toBeTruthy();
  expect(within(panel).getByRole("tab", { name: "zsh" })).toBeTruthy();
  expect(names(app)).toEqual(["tests", "zsh", "zsh 2"]);
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();

  await userEvent.click(within(panel).getByRole("button", { name: "End session zsh 2" }));
  const ask = await screen.findByRole("dialog", { name: "End zsh 2?" });
  await userEvent.click(within(ask).getByRole("button", { name: "End" }));
  await waitFor(() => expect(names(app)).toEqual(["tests", "zsh"]));
  expect(await within(panel).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
});

test("with Side panel chosen in Settings, ⌘J opens the side panel's terminal instead", async () => {
  const storage = memoryKeyValue();
  const settings = await harness({ storage }).open("/settings/general");
  const choice = await screen.findByRole("group", { name: "Terminals open in" });
  await userEvent.click(within(choice).getByRole("button", { name: "Side panel" }));
  settings.unmount();

  await openThread(storage);
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const side = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Terminal panel" })).toBeNull();
});

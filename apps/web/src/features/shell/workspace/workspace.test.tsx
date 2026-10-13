import { coldStartReplay, failingSubagent, seedPanels } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const coldStart = "Cap cold-start replay at 200 events";
/** The Preview tab, titled by the dev server it shows (the thread's web server on 5173). */
const web = "web · :5173";
/** The cold-start totals belong to the last completed turn. */
const changes = "Changes";

async function openColdStart(storage = memoryKeyValue()) {
  const app = harness({ storage });
  app.play(coldStartReplay()).runThrough("turn-2");
  app.play(failingSubagent()).step();
  seedPanels(app.daemon);
  const view = await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: coldStart });
  return { app, view, storage };
}

const sidePanel = () => screen.findByRole("region", { name: "Thread panel" });
const tabNames = (panel: HTMLElement) =>
  within(within(panel).getByRole("tablist", { name: "Thread panel tabs" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent?.replace(/[+−].*$/, "").trim());
const selected = (panel: HTMLElement) =>
  within(within(panel).getByRole("tablist", { name: "Thread panel tabs" })).getByRole("tab", {
    selected: true,
  });

async function launch(panel: HTMLElement, tool: string) {
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: new RegExp(`^${tool}`) }));
}

test("the side panel starts on Summary, Changes and Files, and + opens a new tab that becomes the tool picked", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await sidePanel();
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files"]);

  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  expect(selected(panel).textContent).toBe("New tab");
  await launch(panel, "Preview");
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "New tab", web]);
});

test("a thread's tabs stay with it: another thread doesn't inherit them, and they come back on return", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));

  const threads = screen.getByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /Migrate settings schema/ }));
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
  expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull();

  await userEvent.keyboard("{Meta>}[[{/Meta}");
  await screen.findByRole("heading", { level: 1, name: coldStart });
  expect(selected(await sidePanel()).textContent).toBe(web);
});

test("keyboard Back and Forward walk thread history, the arrows out of the header while the sidebar shows", async () => {
  await openColdStart();
  const header = screen.getByRole("banner");
  expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
  expect(within(header).queryByRole("button", { name: "Forward" })).toBeNull();
  const threads = screen.getByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /Migrate settings schema/ }));
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
  await userEvent.keyboard("{Meta>}[[{/Meta}");
  await screen.findByRole("heading", { level: 1, name: coldStart });
  await userEvent.keyboard("{Meta>}]{/Meta}");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
});

test("tabs survive a reload with the one that was showing", async () => {
  const { view, storage } = await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  expect(selected(await sidePanel()).textContent).toBe("Devices");
  view.unmount();

  await openColdStart(storage);
  const panel = await sidePanel();
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Devices"]);
  expect(selected(panel).textContent).toBe("Devices");
});

test("from the keyboard: arrows show the next tab, Alt+Shift+arrow reorders, Delete closes and focus moves on", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  await launch(panel, "Devices");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", web, "Devices"]);

  within(panel).getByRole("tab", { name: "Devices" }).focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(selected(panel).textContent).toBe(web);
  expect(document.activeElement?.textContent).toBe(web);

  await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Devices", web]);
  expect(screen.getByText(`${web} moved to position 5 of 5`)).toBeTruthy();

  await userEvent.keyboard("{Delete}");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Devices"]);
  expect(selected(panel).textContent).toBe("Devices");
  expect(document.activeElement?.textContent).toBe("Devices");

  // Pinned tools don't close from the keyboard by accident.
  await userEvent.keyboard("{Home}{Delete}");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Devices"]);
});

test("dragging a tab onto another puts it beside that one", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  await launch(panel, "Devices");
  const data = new Map<string, string>();
  const dataTransfer = {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  };
  const tab = (name: string) => within(panel).getByRole("tab", { name }).parentElement!;
  fireEvent.dragStart(tab(web), { dataTransfer });
  fireEvent.dragOver(tab("Devices"), { dataTransfer, clientX: 10 });
  fireEvent.drop(tab("Devices"), { dataTransfer });
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Devices", web]);
  // Reordering doesn't change which tab shows.
  expect(selected(panel).textContent).toBe("Devices");
});

test("a tool's shortcut shows it, and pressed again hides the panel", async () => {
  await openColdStart();
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await sidePanel();
  expect(selected(panel).textContent).toMatch(/^Changes/);

  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  expect(selected(panel).textContent).toBe("Summary");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("hiding the side panel keeps its tabs, and the header then keeps only its toggle", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  // Off Apple platforms the side panel is Ctrl+Alt+B (Ctrl+Shift+B is the Browser there).
  await userEvent.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  // Once the panel has slid out, its toggle is back in the header, alone.
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Right panel" })).toHaveLength(1),
  );
  const toggle = screen.getByRole("button", { name: "Right panel" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");

  await userEvent.click(toggle);
  const back = await sidePanel();
  expect(tabNames(back)).toEqual(["Summary", changes, "Files", web]);
  expect(selected(back).textContent).toBe(web);
});

test("from the keyboard alone: Shift+F10 opens a tab's menu, which can open it in full view", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
  const panel = await sidePanel();
  const logs = await within(panel).findByRole("tab", { name: "Logs", selected: true });
  logs.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  // The panel is the only one: no tab moves between panels any more.
  expect(screen.queryByRole("menuitem", { name: /Move to/ })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Open in full view/ }));
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
  expect(selected(panel).textContent).toBe("Logs");
});

test("a closed tab comes back where it was with Reopen closed tab", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  await launch(panel, "Devices");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", web, "Devices"]);
  within(panel).getByRole("tab", { name: web }).focus();
  await userEvent.keyboard("{Delete}");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Devices"]);

  await userEvent.keyboard("{Control>}{Alt>}{Shift>}t{/Shift}{/Alt}{/Control}");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files", web, "Devices"]);
  expect(selected(panel).textContent).toBe(web);
});

test("full view gives the panel the work area; the way back restores the conversation", async () => {
  await openColdStart();
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await sidePanel();
  await userEvent.click(within(panel).getByRole("button", { name: "Full view" }));
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
  // The header's navigation moves into the panel's strip.
  expect(within(panel).queryByRole("button", { name: "Back" })).toBeNull();

  await userEvent.click(within(panel).getByRole("button", { name: coldStart }));
  expect(await screen.findByRole("feed", { name: "Transcript" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Full view" })).toBeTruthy();
});

test("⌘J shows the thread's terminal as a side panel tab, and the panel's width is kept across a reload", async () => {
  const { view, storage } = await openColdStart();
  // There is no bottom panel any more: the old shortcut shows the terminal beside the thread.
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await sidePanel();
  expect(screen.queryByRole("region", { name: "Bottom panel" })).toBeNull();
  // Its terminal picks up the thread's running zsh.
  expect(await within(panel).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  const handle = within(panel).getByRole("separator", { name: "Resize thread panel" });
  const before = Number(handle.getAttribute("aria-valuenow"));
  handle.focus();
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  const after = Number(handle.getAttribute("aria-valuenow"));
  expect(after).toBeGreaterThan(before);
  view.unmount();

  await openColdStart(storage);
  const restored = await sidePanel();
  expect(
    within(restored)
      .getByRole("separator", { name: "Resize thread panel" })
      .getAttribute("aria-valuenow"),
  ).toBe(String(after));
  expect(within(restored).getByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  // Pressed again while the terminal shows, it hides the panel, as ⌃` does.
  await userEvent.keyboard("{Meta>}j{/Meta}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("New tab contains only tools and opens Files without a Suggested section", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await sidePanel();
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  expect(within(panel).queryByRole("list", { name: "Suggested" })).toBeNull();
  expect(within(panel).queryByRole("combobox", { name: "Address" })).toBeNull();
  await userEvent.click(within(tools).getByRole("button", { name: /^Files/ }));
  expect(selected(panel).textContent).toBe("Files");
  expect(tabNames(panel)).toEqual(["Summary", changes, "Files"]);
});

test("the new tab's tools are one Tab stop that arrow keys move through by row and column", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await sidePanel();
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  const cards = within(tools)
    .getAllByRole("button")
    .filter((button) => !(button.getAttribute("aria-label") ?? "").endsWith("options"));
  expect(cards.filter((card) => card.tabIndex === 0)).toHaveLength(1);
  const [first] = cards;
  if (!first) throw new Error("No tools listed");
  first.focus();
  // Two columns: down moves two tools on, right one.
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(cards[2]);
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(cards[3]);
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(cards.at(-1));
  expect(cards.filter((card) => card.tabIndex === 0)).toEqual([document.activeElement]);
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(first);
});

/** Run a command from ⌘K by typing `query` and picking `label`. */
async function fromPalette(query: string, label: RegExp) {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }), query);
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

test("the command palette pins the showing tab and reopens the tab closed last", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
  const panel = await sidePanel();
  await within(panel).findByRole("tab", { name: "Logs", selected: true });

  await fromPalette("pin logs", /^Pin Logs/);
  await waitFor(() => expect(tabNames(panel)).toEqual(["Summary", changes, "Files", "Logs"]));
  await fromPalette("unpin", /^Unpin Logs/);

  within(panel).getByRole("tab", { name: "Logs" }).focus();
  await userEvent.keyboard("{Delete}");
  await waitFor(() => expect(within(panel).queryByRole("tab", { name: "Logs" })).toBeNull());
  await fromPalette("reopen", /^Reopen closed tab/);
  expect(await within(panel).findByRole("tab", { name: "Logs", selected: true })).toBeTruthy();
});

test("Files keeps its filter across repeated panel hide and reopen", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await sidePanel();
  await userEvent.click(within(panel).getByRole("tab", { name: "Files" }));
  const filter = await within(panel).findByRole("searchbox", {
    name: "Find files in the checkout",
  });
  await userEvent.type(filter, "replay");
  for (let index = 0; index < 3; index++) {
    await userEvent.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
    expect(
      await within(await sidePanel()).findByRole("searchbox", {
        name: "Find files in the checkout",
      }),
    ).toHaveProperty("value", "replay");
  }
});

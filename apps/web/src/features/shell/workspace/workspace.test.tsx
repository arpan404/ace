import { coldStartReplay, failingSubagent, seedPanels } from "@ace/fake-daemon";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const coldStart = "Cap cold-start replay at 200 events";
/** The Preview tab, titled by the dev server it shows (the thread's web server on 5173). */
const web = "web · :5173";

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

test("the side panel starts on Changes and Agents, and + opens a new tab that becomes the tool picked", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await sidePanel();
  expect(tabNames(panel)).toEqual(["Changes", "Agents"]);

  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  expect(selected(panel).textContent).toBe("New tab");
  await launch(panel, "Preview");
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "New tab", web]);
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

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("heading", { level: 1, name: coldStart });
  expect(selected(await sidePanel()).textContent).toBe(web);
});

test("tabs survive a reload with the one that was showing", async () => {
  const { view, storage } = await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  expect(selected(await sidePanel()).textContent).toBe("Devices");
  view.unmount();

  await openColdStart(storage);
  const panel = await sidePanel();
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "Devices"]);
  expect(selected(panel).textContent).toBe("Devices");
});

test("from the keyboard: arrows show the next tab, Alt+Shift+arrow reorders, Delete closes and focus moves on", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  await launch(panel, "Devices");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", web, "Devices"]);

  within(panel).getByRole("tab", { name: "Devices" }).focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(selected(panel).textContent).toBe(web);
  expect(document.activeElement?.textContent).toBe(web);

  await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "Devices", web]);
  expect(screen.getByText(`${web} moved to position 4 of 4`)).toBeTruthy();

  await userEvent.keyboard("{Delete}");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "Devices"]);
  expect(selected(panel).textContent).toBe("Devices");
  expect(document.activeElement?.textContent).toBe("Devices");

  // Pinned tools don't close from the keyboard by accident.
  await userEvent.keyboard("{Home}{Delete}");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "Devices"]);
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
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "Devices", web]);
  // Reordering doesn't change which tab shows.
  expect(selected(panel).textContent).toBe("Devices");
});

test("a tool's shortcut shows it, and pressed again hides the panel", async () => {
  await openColdStart();
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await sidePanel();
  expect(selected(panel).textContent).toMatch(/^Changes/);

  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  expect(selected(panel).textContent).toBe("Agents");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("hidden, the side panel's tabs are counted in the header and listed there", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  // Off Apple platforms the side panel is Ctrl+Alt+B (Ctrl+Shift+B is the Browser there).
  await userEvent.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());

  // The count is what you opened (Preview), not the tools every thread has; the name lists all.
  const count = screen.getByRole("button", { name: `Open tabs: Changes, Agents, ${web}` });
  expect(count.textContent).toBe("1");
  await userEvent.click(count);
  const list = await screen.findByRole("list", { name: "Open tabs" });
  expect(within(list).getByRole("button", { name: `${web}Showing` })).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: "Agents" }));
  expect(selected(await sidePanel()).textContent).toBe("Agents");
});

test("with only the tools every thread has, the header shows no tab count", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await sidePanel();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  expect(screen.queryByRole("button", { name: /^Open tabs/ })).toBeNull();
});

test("from the keyboard alone: Shift+F10 opens a tab's menu, and a tab moves to the side panel with focus", async () => {
  await openColdStart();
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  await userEvent.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
  const logs = await within(bottom).findByRole("tab", { name: "Logs", selected: true });
  logs.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move to side panel" }));
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe("Logs"));
  await waitFor(() => expect(document.activeElement).toBe(selected(panel)));
});

test("a closed tab comes back where it was with Reopen closed tab", async () => {
  await openColdStart();
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await sidePanel();
  await waitFor(() => expect(selected(panel).textContent).toBe(web));
  await launch(panel, "Devices");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", web, "Devices"]);
  within(panel).getByRole("tab", { name: web }).focus();
  await userEvent.keyboard("{Delete}");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "Devices"]);

  await userEvent.keyboard("{Control>}{Alt>}{Shift>}t{/Shift}{/Alt}{/Control}");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", web, "Devices"]);
  expect(selected(panel).textContent).toBe(web);
});

test("full view gives the panel the work area; the way back restores the conversation", async () => {
  await openColdStart();
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await sidePanel();
  await userEvent.click(within(panel).getByRole("button", { name: "Full view" }));
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
  // The header's navigation moves into the panel's strip.
  expect(within(panel).getByRole("button", { name: "Back" })).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: coldStart }));
  expect(await screen.findByRole("feed", { name: "Transcript" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Full view" })).toBeTruthy();
});

test("⌘J shows the bottom panel on a terminal, and its size is kept across a reload", async () => {
  const { view, storage } = await openColdStart();
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const bottom = await screen.findByRole("region", { name: "Bottom panel" });
  // Its terminal picks up the thread's running zsh.
  expect(await within(bottom).findByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Bottom panel" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  const handle = within(bottom).getByRole("separator", { name: "Resize bottom panel" });
  expect(handle.getAttribute("aria-valuenow")).toBe("240");
  handle.focus();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  expect(handle.getAttribute("aria-valuenow")).toBe("272");
  view.unmount();

  await openColdStart(storage);
  const restored = await screen.findByRole("region", { name: "Bottom panel" });
  expect(
    within(restored)
      .getByRole("separator", { name: "Resize bottom panel" })
      .getAttribute("aria-valuenow"),
  ).toBe("272");
  await userEvent.keyboard("{Control>}`{/Control}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Bottom panel" })).toBeNull());
});

test("the new tab suggests the thread's dev server and edited files, and opens them", async () => {
  await openColdStart();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await sidePanel();
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const suggested = await within(panel).findByRole("list", { name: "Suggested" });
  expect(await within(suggested).findByRole("button", { name: /^web/ })).toBeTruthy();
  // An edited file opens in the Files tool, in the new tab's place.
  await userEvent.click(within(suggested).getByRole("button", { name: /^replay\.ts/ }));
  expect(selected(panel).textContent).toBe("replay.ts");
  expect(tabNames(panel)).toEqual(["Changes", "Agents", "replay.ts"]);
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
  cards[0]!.focus();
  // Two columns: down moves two tools on, right one.
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(cards[2]);
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(cards[3]);
  await userEvent.keyboard("{End}");
  expect(document.activeElement?.textContent).toMatch(/^Deck/);
  expect(cards.filter((card) => card.tabIndex === 0)).toEqual([document.activeElement]);
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(cards[0]);
});

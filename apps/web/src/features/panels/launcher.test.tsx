import { coldStartReplay } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openNewTab() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  return { app, panel };
}

test("the new tab lists its tools as cards with their shortcuts, and no Side chat", async () => {
  const { panel } = await openNewTab();
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  const terminal = within(tools)
    .getAllByRole("button", { name: /^Terminal/ })
    .find((button) => button.hasAttribute("data-tool"));
  expect(terminal?.getAttribute("aria-keyshortcuts")).toBe("ctrl+`");
  expect(terminal?.querySelector("kbd")).toBeTruthy();
  expect(within(tools).getByRole("button", { name: "More for Files" })).toBeTruthy();
  expect(within(tools).queryByRole("button", { name: /Side chat/ })).toBeNull();
  expect(within(panel).queryByRole("tab", { name: "Side chat" })).toBeNull();
  // Terminals open one per tab, so its card offers another beside this one.
  expect(within(tools).getByRole("button", { name: "More for Terminal" })).toBeTruthy();
  expect(within(tools).queryByRole("button", { name: "More for Changes" })).toBeNull();
});

test("the new tab suggests the dev servers the daemon detected for the thread", async () => {
  const { panel } = await openNewTab();
  const suggested = await within(panel).findByRole("list", { name: "Suggested" });
  const vite = await within(suggested).findByRole("button", { name: /^Vite \+ React \+ TS/ });
  expect(vite.textContent).toContain("localhost:5173");
  expect(within(suggested).getByRole("button", { name: /^Next\.js/ })).toBeTruthy();
});

test("an address typed in the new tab's toolbar opens the Browser in its place", async () => {
  const { panel } = await openNewTab();
  const address = await within(panel).findByRole("combobox", { name: "Address" });
  expect(address.getAttribute("placeholder")).toBe("Search or enter a URL");
  await userEvent.type(address, "localhost:4321{Enter}");
  expect(await within(panel).findByRole("tab", { name: /localhost/, selected: true })).toBeTruthy();
  expect(within(panel).queryByRole("tab", { name: "New tab" })).toBeNull();
});

test("opening a new tab puts the cursor in its address", async () => {
  const { panel } = await openNewTab();
  const address = await within(panel).findByRole("combobox", { name: "Address" });
  await waitFor(() => expect(document.activeElement).toBe(address));
});

test("picking Terminal from the new tab leaves one tab: the terminal, in the new tab's place", async () => {
  const { panel } = await openNewTab();
  const tabs = within(panel).getAllByRole("tab").length;
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  const terminal = within(tools)
    .getAllByRole("button", { name: /^Terminal/ })
    .find((button) => button.hasAttribute("data-tool"));
  if (!terminal) throw new Error("No Terminal card");
  await userEvent.click(terminal);
  await waitFor(() => expect(within(panel).queryByRole("tab", { name: "New tab" })).toBeNull());
  expect(within(panel).getAllByRole("tab")).toHaveLength(tabs);
  expect(within(panel).getByRole("tab", { selected: true }).textContent).not.toMatch(/New tab/);
});

test("a tool's shortcut pressed on the new tab opens it in the new tab's place", async () => {
  const { panel } = await openNewTab();
  const tabs = within(panel).getAllByRole("tab").length;
  await within(panel).findByRole("list", { name: "Tools" });
  // ⌃⇧P: Preview.
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  expect(await within(panel).findByRole("tab", { name: "Preview", selected: true })).toBeTruthy();
  expect(within(panel).queryByRole("tab", { name: "New tab" })).toBeNull();
  expect(within(panel).getAllByRole("tab")).toHaveLength(tabs);
});

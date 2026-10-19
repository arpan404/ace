import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const thread = "thread-cold-start";

/** The thread with its Browser showing the agent's page in the side panel. */
async function openBrowser() {
  const scenario = coldStartReplay();
  const app = harness();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", {
    name: "Live view of localhost:5173/settings/devices",
  });
  return { panel, browser: app.daemon.browser };
}

const shownTab = (panel: HTMLElement) =>
  within(within(panel).getByRole("tablist", { name: "Thread panel tabs" })).getByRole("tab", {
    selected: true,
  });

test("a blank tab an agent opens comes forward without taking the cursor from the composer", async () => {
  const { panel, browser } = await openBrowser();
  const composer = screen.getByRole("combobox", { name: "Message" });
  await userEvent.click(composer);
  await userEvent.type(composer, "Half a thought");

  const opened = browser.view(thread)?.tabs?.length ?? 0;
  act(() => void browser.tabOpen(thread, "about:blank", { agentId: "worker" }));
  // The panel follows the agent's new tab, which starts blank.
  await waitFor(() => expect(browser.view(thread)?.tabs).toHaveLength(opened + 1));
  await waitFor(() => expect(shownTab(panel).textContent).not.toContain("devices"));
  await within(panel).findByRole("combobox", { name: "Address" });

  expect(document.activeElement).toBe(composer);
  await userEvent.keyboard(" and the rest");
  expect(composer.textContent).toBe("Half a thought and the rest");
});

test("a blank tab the person opens while typing in the composer leaves the cursor there", async () => {
  const { panel, browser } = await openBrowser();
  const composer = screen.getByRole("combobox", { name: "Message" });
  await userEvent.click(composer);
  await userEvent.type(composer, "Still writing");

  // Opened from another device, or by a shortcut that keeps the keyboard here.
  act(() => void browser.personOpen(thread));
  await waitFor(() => expect(shownTab(panel).textContent).not.toContain("devices"));
  await within(panel).findByRole("combobox", { name: "Address" });

  expect(document.activeElement).toBe(composer);
});

import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";

const thread = "thread-cold-start";

async function openBrowser() {
  const scenario = coldStartReplay();
  browserVideo();
  const app = harness();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", { name: "Live view of localhost:5173/settings/devices" });
  const browser = app.daemon.browser;
  return { panel, browser, start: browser.view(thread)?.url };
}

const button = (panel: HTMLElement, name: "Back" | "Forward") =>
  within(panel).getByRole("button", { name });
const enabled = (panel: HTMLElement, name: "Back" | "Forward") =>
  button(panel, name).getAttribute("aria-disabled") !== "true";

test("Back lights up when a single-page app moves within its page, and returns there", async () => {
  const { panel, browser, start } = await openBrowser();
  expect(enabled(panel, "Back")).toBe(false);
  // The app pushes a history entry of its own: no new document, no reload.
  act(() => browser.navigateInPage(thread, "http://localhost:5173/settings/profile"));
  await waitFor(() => expect(enabled(panel, "Back")).toBe(true));
  expect(enabled(panel, "Forward")).toBe(false);

  await userEvent.click(button(panel, "Back"));
  await waitFor(() => expect(browser.view(thread)?.url).toBe(start));
  await waitFor(() => expect(enabled(panel, "Forward")).toBe(true));
  expect(enabled(panel, "Back")).toBe(false);
});

test("a page that opens a dialog as it loads can still be left with Back", async () => {
  const { panel, browser, start } = await openBrowser();
  act(() => {
    browser.navigate(thread, "https://example.org/alerts");
    browser.dialogOpen(thread, {
      dialogId: "on-load",
      tabId: browser.view(thread)?.activeTabId ?? "",
      type: "alert",
      message: "Welcome!",
    });
  });
  await waitFor(() =>
    expect(within(panel).getByRole("combobox", { name: "Address" }).getAttribute("value")).toBe(
      "example.org/alerts",
    ),
  );
  // The dialog holds the page, not the toolbar: Back stays usable while it is open.
  await waitFor(() => expect(enabled(panel, "Back")).toBe(true));
  await userEvent.click(button(panel, "Back"));
  await waitFor(() => expect(browser.view(thread)?.url).toBe(start));
});

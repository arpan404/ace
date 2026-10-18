import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserMenu, openThreadBrowser } from "./views-test-support.tsx";

test("Screenshot at sizes captures the shown tab at the widths picked and says they were saved", async () => {
  const { panel, browser, thread } = await openThreadBrowser();
  const tabId = browser.view(thread)?.activeTabId;
  await browserMenu(panel, "Screenshot at sizes…");
  const dialog = await screen.findByRole("dialog", { name: "Screenshot at sizes" });
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /Tablet/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Take screenshots" }));
  expect(await screen.findByText("2 screenshots saved to this thread")).toBeTruthy();
  expect(browser.sizedCaptures).toEqual([{ threadId: thread, tabId, sizes: ["phone", "desktop"] }]);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Screenshot at sizes" })).toBeNull(),
  );
});

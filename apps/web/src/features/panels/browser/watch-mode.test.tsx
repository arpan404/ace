import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { openThreadBrowser } from "./views-test-support.tsx";

const width = () => {
  const handle = screen.getByRole("separator", { name: "Resize thread panel" });
  return {
    now: Number(handle.getAttribute("aria-valuenow")),
    max: Number(handle.getAttribute("aria-valuemax")),
  };
};
const strip = (panel: HTMLElement) =>
  within(panel).getByRole("tablist", { name: "Thread panel tabs" });

test("watch mode shows the agent's tab as wide as the panel goes, follows it, and puts the panel back when the agents stop working", async () => {
  const { panel, browser, thread, script } = await openThreadBrowser();
  act(() => browser.agentWorks(thread, { agentId: "worker" }));
  // The person looks at another tool meanwhile.
  await userEvent.click(within(strip(panel)).getByRole("tab", { name: /^Changes/ }));
  const before = width().now;
  await userEvent.click(
    within(strip(panel)).getByRole("tab", { name: /settings\/devices|Fixture|localhost/ }),
  );
  await userEvent.click(await within(panel).findByRole("button", { name: "Watch the agent" }));
  await waitFor(() => expect(width().now).toBe(width().max));
  expect(width().now).toBeGreaterThan(before);
  // The agent opens a tab of its own: watch mode follows it there.
  act(() => {
    browser.agentIdle(thread);
    browser.tabOpen(thread, "https://shop.example/cart", { agentId: "worker", label: "checkout" });
  });
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://shop.example/cart"));
  expect(within(panel).getByRole("button", { name: "Stop watching the agent" })).toBeTruthy();
  // The run ends: the panel is as it was before watching.
  act(() => script.runThrough("root-replied"));
  await waitFor(() => expect(width().now).toBe(before));
  // Back on the tab the person had shown.
  await waitFor(() => expect(browser.view(thread)?.url).toBe("localhost:5173/settings/devices"));
});

test("the person leaves watch mode with the same button, back to the earlier layout", async () => {
  const { panel, browser, thread } = await openThreadBrowser();
  act(() => browser.agentWorks(thread, { agentId: "worker" }));
  const before = width().now;
  await userEvent.click(await within(panel).findByRole("button", { name: "Watch the agent" }));
  await waitFor(() => expect(width().now).toBe(width().max));
  await userEvent.click(within(panel).getByRole("button", { name: "Stop watching the agent" }));
  await waitFor(() => expect(width().now).toBe(before));
});

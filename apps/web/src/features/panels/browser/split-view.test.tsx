import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { tabDragType } from "@/lib/workspace/index.ts";
import { openThreadBrowser } from "./views-test-support.tsx";

const addresses = (panel: HTMLElement) =>
  within(panel).queryAllByRole("combobox", { name: "Address" });

async function go(field: HTMLElement, text: string) {
  await userEvent.clear(field);
  await userEvent.type(field, `${text}{Enter}`);
}

test("split view shows two tabs side by side, each with its own address bar, navigating on its own", async () => {
  const { panel, browser, thread } = await openThreadBrowser();
  const first = browser.view(thread)?.activeTabId ?? "";
  let second = "";
  // The person picked the tab they view, so the agent's new tab stays in the background.
  act(() => browser.tabSelect(thread, first));
  act(() => {
    second = browser.tabOpen(thread, "https://docs.example/guide", { agentId: "a" });
    browser.pageIdentity(thread, { title: "Guide" }, second);
  });
  await waitFor(() =>
    expect(
      within(panel)
        .getAllByRole("tab")
        .some((tab) => tab.textContent?.includes("Guide")),
    ).toBe(true),
  );
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in split view" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Guide" }));
  await waitFor(() => expect(addresses(panel)).toHaveLength(2));
  const url = (tabId: string) => browser.tabsList(thread).find((tab) => tab.tabId === tabId)?.url;

  const [left, right] = addresses(panel);
  await go(right as HTMLElement, "example.org");
  await waitFor(() => expect(url(second)).toBe("https://example.org/"));
  expect(url(first)).toBe("localhost:5173/settings/devices");
  await go(left as HTMLElement, "arpan.sh");
  await waitFor(() => expect(url(first)).toBe("https://arpan.sh/"));
  expect(url(second)).toBe("https://example.org/");
  // Both halves stay through working in either.
  expect(addresses(panel)).toHaveLength(2);

  // Closing one half returns the panel to one tab.
  const halves = within(panel).getAllByRole("button", { name: "Browser options" });
  await userEvent.click(halves[1] as HTMLElement);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Close split view" }));
  await waitFor(() => expect(addresses(panel)).toHaveLength(1));
});

test("dragging a top tab onto the page's right half opens it there in split view", async () => {
  const { panel, browser, thread } = await openThreadBrowser();
  const first = browser.view(thread)?.activeTabId ?? "";
  act(() => browser.tabSelect(thread, first));
  const before = within(panel).getAllByRole("tab").length;
  let second = "";
  act(() => {
    second = browser.tabOpen(thread, "https://docs.example/guide", { agentId: "a" });
  });
  // The agent's tab joins the strip, ready to be dragged.
  await waitFor(() => expect(within(panel).getAllByRole("tab")).toHaveLength(before + 1));
  const page = panel.querySelector<HTMLElement>("[data-browser-tab]");
  if (!page) throw new Error("No browser tab");
  const dataTransfer = {
    types: [tabDragType],
    getData: (type: string) => (type === tabDragType ? `browser:${second}` : ""),
  };
  fireEvent.dragOver(page, { dataTransfer, clientX: 10 });
  fireEvent.drop(page, { dataTransfer, clientX: 10 });
  await waitFor(() => expect(addresses(panel)).toHaveLength(2));
  expect(within(panel).getAllByRole("button", { name: "Browser options" })).toHaveLength(2);
});

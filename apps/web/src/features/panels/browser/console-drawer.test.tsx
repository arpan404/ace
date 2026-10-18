import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserMenu, openThreadBrowser } from "./views-test-support.tsx";

test("the console drawer lists the tab's messages by level and its failed requests, and Clear empties it", async () => {
  const { panel, browser, thread } = await openThreadBrowser();
  act(() => {
    browser.logs.add(thread, { kind: "console", type: "log", text: "app booted" });
    browser.logs.add(thread, { kind: "console", type: "error", text: "TypeError: x is undefined" });
    browser.logs.add(thread, {
      kind: "network",
      type: "response",
      url: "http://localhost:5173/api/devices",
      status: 200,
      method: "GET",
      bytes: 1840,
      durationMs: 42,
      text: "200 http://localhost:5173/api/devices",
    });
    browser.logs.add(thread, {
      kind: "network",
      type: "failed",
      url: "http://localhost:5173/api/pair",
      method: "POST",
      text: "http://localhost:5173/api/pair net::ERR_CONNECTION_REFUSED",
    });
  });
  await browserMenu(panel, "Console and network");
  const drawer = await within(panel).findByRole("region", { name: "Console and network" });
  const messages = await within(drawer).findByRole("list", { name: "Console messages" });
  await waitFor(() =>
    expect(
      within(messages)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["app booted", "TypeError: x is undefined"]),
  );
  // Only errors.
  await userEvent.click(within(drawer).getByRole("button", { name: "Level: All levels" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Errors" }));
  expect(
    within(messages)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual(["TypeError: x is undefined"]);

  // The network list: status, method, address, size and time; then only the failed request.
  await userEvent.click(within(drawer).getByRole("button", { name: "Network" }));
  const requests = await within(drawer).findByRole("table", { name: "Network requests" });
  const rows = () =>
    within(requests)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
  expect(rows()).toEqual([
    ["200", "GET", "http://localhost:5173/api/devices", "1.8 kB", "42 ms"],
    ["Failed", "POST", "http://localhost:5173/api/pair", "", ""],
  ]);
  await userEvent.click(within(drawer).getByRole("button", { name: "Requests: All requests" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Failed" }));
  expect(rows()).toEqual([["Failed", "POST", "http://localhost:5173/api/pair", "", ""]]);

  // Clear hides what is listed; a request after it shows.
  await userEvent.click(within(drawer).getByRole("button", { name: "Clear the requests" }));
  expect(within(drawer).getByText("No requests")).toBeTruthy();
  act(() =>
    browser.logs.add(thread, {
      kind: "network",
      type: "failed",
      url: "http://localhost:5173/api/retry",
      method: "POST",
      text: "retry failed",
    }),
  );
  await waitFor(
    () =>
      expect(
        within(drawer).getByRole("cell", { name: "http://localhost:5173/api/retry" }),
      ).toBeTruthy(),
    { timeout: 3000 },
  );
});

test("the drawer stays open on its tab across reopening the panel, and closes from its own button", async () => {
  const { panel } = await openThreadBrowser();
  await browserMenu(panel, "Console and network");
  await within(panel).findByRole("region", { name: "Console and network" });
  // Hide and show the panel: the tab remembers its drawer.
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Console and network" })).toBeNull(),
  );
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const drawer = await screen.findByRole("region", { name: "Console and network" });
  await userEvent.click(within(drawer).getByRole("button", { name: "Close the console" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Console and network" })).toBeNull(),
  );
});

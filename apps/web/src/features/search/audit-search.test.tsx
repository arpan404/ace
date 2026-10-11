import { workbench } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function open() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new");
  await userEvent.click(
    within(await screen.findByRole("navigation", { name: "App" })).getByRole("button", {
      name: "Search",
    }),
  );
  const field = await screen.findByRole("combobox", { name: "Search every thread" });
  return { app, field };
}

test("Enter and clicks do not open a result belonging to the previous query", async () => {
  const { app, field } = await open();
  await userEvent.type(field, "retry budget");
  const list = await screen.findByRole("listbox", { name: "Results" });
  const old = within(list).getAllByRole("option")[0];
  app.daemon.holdRequests("search.query");
  await userEvent.clear(field);
  await userEvent.type(field, "invoice");
  fireEvent.keyDown(field, { key: "Enter" });
  if (old) fireEvent.click(old);
  expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
  expect(
    screen.queryByRole("heading", { level: 1, name: "Retry budget for app-server restarts" }),
  ).toBeNull();
});

test("Safari IME confirmation leaves Search open without activating a result", async () => {
  const { field } = await open();
  await userEvent.type(field, "retry");
  await screen.findByRole("listbox", { name: "Results" });
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229, isComposing: false });
  expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
  expect(field.getAttribute("value")).toBe("retry");
});

test("offline Search explains reconnection instead of showing an endless loading row", async () => {
  const { app, field } = await open();
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  await userEvent.type(field, "retry");
  expect(await screen.findByText("Search is offline")).toBeTruthy();
  expect(screen.getByText("Search when reconnected.")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading results" })).toBeNull();
});

test("Command K replaces Search with the palette", async () => {
  await open();
  await userEvent.keyboard("{Meta>}k{/Meta}");
  expect(await screen.findByRole("combobox", { name: "Search commands" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
});

test("Search opens the thread immediately while locating an older matching item", async () => {
  const { app, field } = await open();
  app.daemon.holdRequests("thread.search");
  await userEvent.type(field, "retry budget");
  const list = await screen.findByRole("listbox", { name: "Results" });
  const hits = within(list).getAllByRole("option");
  // The transcript hit has a sequence to locate; the title hit doesn't.
  const message = hits.find((hit) => hit.textContent?.includes("connection")) ?? hits[1];
  if (!message) throw new Error("Missing transcript hit");
  fireEvent.click(message);
  fireEvent.click(message);
  expect(
    await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
});

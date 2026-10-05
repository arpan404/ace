import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openApp(path = "/") {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open(path);
  if (path === "/activity") await screen.findByRole("heading", { level: 1, name: "Activity" });
  else
    await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}
const palette = async () => {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  return screen.findByRole("combobox", { name: "Search commands" });
};
const options = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");

test("⌘K finds a thread by its branch and opens it", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "perf/fan");
  // The thread, then the way into full-text search.
  await waitFor(() =>
    expect(options()).toEqual([
      "Backpressure on broadcast fan-outrelay · perf/fanoutThreads",
      "Search all threads for “perf/fan”",
    ]),
  );
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull();
});

test("threads in the palette follow Home order, needs-you first and settled last", async () => {
  await openApp();
  await palette();
  const threads = within(await screen.findByRole("group", { name: "Threads" }))
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  expect(threads[0]).toMatch(/^Partial refunds double-count tax/);
  expect(threads.at(-1)).toMatch(/^Bump Codex app-server to 0.48/);
});

test("picking a project narrows Home to it", async () => {
  await openApp("/activity");
  const search = await palette();
  await userEvent.type(search, "billing");
  const project = await screen.findByRole("option", { name: /^billing-api.*Projects$/ });
  await userEvent.click(project);
  expect(await screen.findByRole("button", { name: "Project filter: billing-api" })).toBeTruthy();
  // Home opens the filtered list's top thread.
  expect(
    await screen.findByRole("heading", { level: 1, name: /Partial refunds|Invoice PDF/ }),
  ).toBeTruthy();
  // Only billing-api's folder is left, with its two threads.
  const list = within(screen.getByRole("navigation", { name: "Threads" }));
  expect(list.getAllByRole("button", { expanded: true }).map((b) => b.textContent)).toEqual([
    "billing-api",
  ]);
  expect(list.getAllByRole("link")).toHaveLength(2);
});

test("on a settled thread, the palette brings it back to the list", async () => {
  await openApp("/t/thread-bump-codex");
  await screen.findByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" });
  const search = await palette();
  await userEvent.type(search, "unsettle this");
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByText("Back in the list · Bump Codex app-server to 0.48")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (0)" })).toBeTruthy());
});

test("the palette offers no Settle for a thread that is still working", async () => {
  await openApp("/t/thread-fan-out");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  const search = await palette();
  await userEvent.type(search, "settle this");
  expect(screen.queryByRole("option", { name: /Settle this thread/ })).toBeNull();
});

test("with a query, commands rank by how well they match, letters in order included", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "nwthr");
  await waitFor(() => expect(options()[0]).toMatch(/^New thread/));
  await userEvent.clear(search);
  await userEvent.type(search, "settings");
  await waitFor(() => expect(options()[0]).toMatch(/^SettingsGo to/));
});

test("a query nothing matches falls through to searching every thread", async () => {
  await openApp();
  const search = await palette();
  await userEvent.type(search, "qqqzzz");
  await waitFor(() => expect(options()).toEqual(["Search all threads for “qqqzzz”"]));
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull();
});

test("threads opened lately come first with an empty query, the open one aside", async () => {
  await openApp("/t/thread-fan-out");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  const threads = within(screen.getByRole("navigation", { name: "Threads" }));
  await userEvent.click(threads.getByRole("link", { name: /^Partial refunds double-count tax/ }));
  await screen.findByRole("heading", { level: 1, name: /^Partial refunds double-count tax/ });
  await palette();
  const recent = within(await screen.findByRole("group", { name: "Recent threads" }));
  expect(recent.getAllByRole("option").map((option) => option.textContent)).toEqual([
    expect.stringMatching(/^Backpressure on broadcast fan-out/),
  ]);
});

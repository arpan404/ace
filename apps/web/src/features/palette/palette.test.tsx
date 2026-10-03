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
  await waitFor(() =>
    expect(options()).toEqual(["Backpressure on broadcast fan-outrelay · perf/fanout"]),
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
  const project = within(await screen.findByRole("group", { name: "Projects" })).getByRole(
    "option",
  );
  await userEvent.click(project);
  expect(await screen.findByRole("button", { name: "Project filter: billing-api" })).toBeTruthy();
  // Home opens the filtered list's top thread.
  expect(
    await screen.findByRole("heading", { level: 1, name: /Partial refunds|Invoice PDF/ }),
  ).toBeTruthy();
  const links = within(screen.getByRole("navigation", { name: "Threads" })).getAllByRole("link");
  expect(links.every((link) => link.textContent?.includes("billing-api"))).toBe(true);
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

import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

type Harness = ReturnType<typeof harness>;

const results = () => screen.findByRole("listbox", { name: "Results" });
const field = () => screen.getByRole<HTMLInputElement>("combobox", { name: "Search every thread" });

/** Open the app, then the search dialog from the sidebar's Search, and type `query`. */
async function search(query = "", app: Harness = harness()) {
  const view = await app.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("button", { name: "Search" }),
  );
  await screen.findByRole("dialog", { name: "Search" });
  if (query) await userEvent.type(field(), query);
  return view;
}

afterEach(() => localStorage.clear());

test("every word must match, and matches are highlighted in the snippet", async () => {
  await search("retry budget");

  const options = within(await results()).getAllByRole("option");
  expect(options).toHaveLength(2);
  for (const option of options)
    expect(option.textContent).toContain("Retry budget for app-server restarts");
  const marks = options.map((option) =>
    [...option.querySelectorAll("mark")].map((mark) => mark.textContent?.toLowerCase()),
  );
  expect(marks).toEqual([
    ["retry", "budget"],
    ["retry", "budget"],
  ]);
});

test("the kind filter keeps only commands", async () => {
  await search("dedupe");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);

  await userEvent.type(field(), "{Control>}a{/Control}push");
  await userEvent.click(screen.getByRole("button", { name: "Commands" }));

  await waitFor(async () => {
    const options = within(await results()).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("git push --force-with-lease");
  });
});

test("arrow keys move through results and Enter opens the thread", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await search("the", app);
  const options = within(await results()).getAllByRole("option");
  expect(options[0]?.textContent).toContain("Dedupe thread events after reconnect");
  expect(options[0]?.getAttribute("aria-selected")).toBe("true");

  await userEvent.keyboard("{ArrowDown}");
  const second = within(await results()).getAllByRole("option")[1];
  expect(second?.getAttribute("aria-selected")).toBe("true");
  expect(second?.textContent).toContain("Retry budget for app-server restarts");
  await userEvent.keyboard("{Enter}");

  expect(
    await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" }),
  ).toBeTruthy();
  // Opening a result puts the dialog away.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
});

test("a search with no matches says so", async () => {
  await search("kubernetes");
  expect(await screen.findByText("No results")).toBeTruthy();
});

test("emptying the field empties the results; Esc puts the dialog away, and it opens fresh", async () => {
  await search("replay");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(2);
  expect(screen.getByText(/^\d+\+? results?$/)).toBeTruthy();
  await userEvent.clear(field());
  expect(screen.queryByRole("option")).toBeNull();

  await userEvent.type(field(), "replay");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
  await userEvent.keyboard("{Shift>}{Meta>}k{/Meta}{/Shift}");
  await screen.findByRole("dialog", { name: "Search" });
  expect(field().value).toBe("");
  expect(document.activeElement).toBe(field());
});

test("the palette hands its words to search", async () => {
  await harness().open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  await userEvent.type(within(palette).getByRole("combobox"), "retry budget");
  await userEvent.click(
    within(palette).getByRole("option", { name: "Search all threads for “retry budget”" }),
  );
  await screen.findByRole("dialog", { name: "Search" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  expect(field().value).toBe("retry budget");
  expect(within(await results()).getAllByRole("option")).toHaveLength(2);
});

test("results are options themselves, with nothing focusable inside them", async () => {
  await search("dedupe");
  const options = within(await results()).getAllByRole("option");
  for (const option of options) expect(option.querySelector("a, button, [tabindex]")).toBeNull();
});

test("a search that was opened is offered again from Recent, and can be forgotten", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const first = await search("retry budget", app);
  await within(await results()).findAllByRole("option");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" });
  first.unmount();

  await search();
  const recent = await screen.findByRole("region", { name: "Recent" });
  await userEvent.click(within(recent).getByRole("button", { name: "retry budget" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);

  await userEvent.clear(field());
  await userEvent.click(
    within(await screen.findByRole("region", { name: "Recent" })).getByRole("button", {
      name: 'Forget "retry budget"',
    }),
  );
  expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
});

test("when search fails, the dialog says why and tries again", async () => {
  const app = harness();
  app.daemon.failRequests("search.query");
  await search("dedupe", app);
  expect(await screen.findByText("Search unavailable", {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText("unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);
});

import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const results = () => screen.findByRole("listbox", { name: "Results" });

afterEach(() => localStorage.clear());

test("every word must match, and matches are highlighted in the snippet", async () => {
  await harness().open("/more/search");

  await userEvent.type(
    await screen.findByRole("combobox", { name: "Search every thread" }),
    "retry budget",
  );

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
  await harness().open("/more/search?q=dedupe");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);

  await userEvent.type(
    screen.getByRole("combobox", { name: "Search every thread" }),
    "{Control>}a{/Control}push",
  );
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
  await app.open("/more/search");
  const input = await screen.findByRole("combobox", { name: "Search every thread" });

  await userEvent.type(input, "the");
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
});

test("a search with no matches says so", async () => {
  await harness().open("/more/search?q=kubernetes");
  expect(await screen.findByText("No results")).toBeTruthy();
});

test("Clear empties the query and the results; Esc clears, then leaves the field", async () => {
  await harness().open("/more/search?q=replay");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(2);
  expect(screen.getByText(/^\d+\+? results?$/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  const input = screen.getByRole("combobox", { name: "Search every thread" });
  expect(input).toHaveProperty("value", "");
  expect(screen.queryByRole("option")).toBeNull();

  await userEvent.type(input, "replay");
  await userEvent.keyboard("{Escape}");
  expect(input).toHaveProperty("value", "");
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).not.toBe(input);
});

test("results are options themselves, with nothing focusable inside them", async () => {
  await harness().open("/more/search?q=dedupe");
  const options = within(await results()).getAllByRole("option");
  for (const option of options) expect(option.querySelector("a, button, [tabindex]")).toBeNull();
});

test("a search that was opened is offered again from Recent, and can be forgotten", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const first = await app.open("/more/search");
  const input = await screen.findByRole("combobox", { name: "Search every thread" });
  await userEvent.type(input, "retry budget");
  await within(await results()).findAllByRole("option");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" });
  first.unmount();

  await harness().open("/more/search");
  const recent = await screen.findByRole("region", { name: "Recent" });
  await userEvent.click(within(recent).getByRole("button", { name: "retry budget" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);

  await userEvent.click(screen.getAllByRole("button", { name: "Clear" })[0]!);
  await userEvent.click(
    within(await screen.findByRole("region", { name: "Recent" })).getByRole("button", {
      name: 'Forget "retry budget"',
    }),
  );
  expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
});

test("when search fails, the page says why and tries again", async () => {
  const app = harness();
  app.daemon.failRequests("search.query");
  await app.open("/more/search?q=dedupe");
  expect(await screen.findByText("Search unavailable", {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText("unavailable")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(0);
});

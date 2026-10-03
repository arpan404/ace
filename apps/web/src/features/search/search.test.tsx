import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const results = () => screen.findByRole("listbox", { name: "Results" });

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

test("Clear empties the query and the results", async () => {
  await harness().open("/more/search?q=replay");
  expect(within(await results()).getAllByRole("option").length).toBeGreaterThan(2);
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  const input = screen.getByRole("combobox", { name: "Search every thread" });
  expect(input).toHaveProperty("value", "");
  expect(screen.queryByRole("option")).toBeNull();
});

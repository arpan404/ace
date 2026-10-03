import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("starting a deck drafts a plan behind a gate, and approving it deals the first card", async () => {
  await harness().open("/deck/new");
  const form = await screen.findByRole("form", { name: "New deck" });

  await userEvent.type(
    within(form).getByLabelText("Goal"),
    "Stream terminal output to the phone without dropping bytes on reconnect.",
  );
  await userEvent.click(within(form).getByRole("button", { name: /Start deck/ }));

  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: /^Stream terminal output to the phone without dropping/,
    }),
  ).toBeTruthy();
  const gate = screen.getByRole("region", { name: "Deck plan needs your approval" });
  expect(screen.getByRole("button", { name: /Map the current behaviour/ }).textContent).toContain(
    "Planned",
  );
  const decks = screen.getByRole("navigation", { name: "Decks" });
  expect(
    within(within(decks).getByRole("region", { name: "Gated" })).getByText(
      /Stream terminal output/,
    ),
  ).toBeTruthy();

  await userEvent.click(within(gate).getByRole("button", { name: "Approve plan" }));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Map the current behaviour/ }).textContent).toContain(
      "Working",
    ),
  );
  expect(screen.getByRole("button", { name: /Make the change/ }).textContent).toContain("Planned");
});

test("a deck without plan approval starts dealing straight away", async () => {
  await harness().open("/deck/new");
  const form = await screen.findByRole("form", { name: "New deck" });

  await userEvent.type(within(form).getByLabelText("Goal"), "Cache model lists per account.");
  await userEvent.click(within(form).getByRole("switch"));
  fireEvent.keyDown(within(form).getByLabelText("Goal"), { key: "Enter", metaKey: true });

  await screen.findByRole("heading", { level: 1, name: "Cache model lists per account" });
  expect(screen.queryByRole("region", { name: "Deck plan needs your approval" })).toBeNull();
  expect(screen.getByRole("button", { name: /Map the current behaviour/ }).textContent).toContain(
    "Working",
  );
});

test("a goal too short to plan from is refused with a reason", async () => {
  await harness().open("/deck/new");
  const form = await screen.findByRole("form", { name: "New deck" });

  await userEvent.type(within(form).getByLabelText("Goal"), "Fix it");
  await userEvent.click(within(form).getByRole("button", { name: /Start deck/ }));

  expect((await within(form).findByRole("alert")).textContent).toBe(
    "Describe the goal in a sentence or two.",
  );
  expect(screen.getByRole("heading", { level: 1, name: "New deck" })).toBeTruthy();
});

test("⌘⇧N opens New deck from anywhere", async () => {
  await harness().open("/deck/relay-streams");
  await screen.findByRole("heading", { level: 1, name: "Resumable relay streams" });

  await userEvent.keyboard("{Meta>}{Shift>}n{/Shift}{/Meta}");

  expect(await screen.findByRole("form", { name: "New deck" })).toBeTruthy();
});

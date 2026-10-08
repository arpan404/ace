import { workbenchServices } from "@ace/fake-daemon";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** A daemon with one project to deal decks in. */
async function openNew() {
  const app = harness();
  app.daemon.createThread({ id: "thread-a", workspaceId: "ace", title: "A", provider: "codex" });
  await app.open("/offshifts/new");
  return app;
}

test("starting a deck drafts a plan behind a gate, and approving it deals the first card", async () => {
  await openNew();
  const form = await screen.findByRole("form", { name: "New offshift" });

  await userEvent.type(
    within(form).getByLabelText("Goal"),
    "Stream terminal output to the phone without dropping bytes on reconnect.",
  );
  await userEvent.click(within(form).getByRole("button", { name: /Start offshift/ }));

  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: /^Stream terminal output to the phone without dropping/,
    }),
  ).toBeTruthy();
  const gate = screen.getByRole("region", { name: "Offshift plan needs your approval" });
  expect(screen.getByRole("button", { name: /Map the current behaviour/ }).textContent).toContain(
    "Planned",
  );
  const decks = screen.getByRole("navigation", { name: "Offshifts" });
  expect(
    within(within(decks).getByRole("region", { name: "Needs you" })).getByText(
      /Stream terminal output/,
    ),
  ).toBeTruthy();

  await userEvent.click(within(gate).getByRole("button", { name: /^Approve plan/ }));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Map the current behaviour/ }).textContent).toContain(
      "Working",
    ),
  );
  expect(screen.getByRole("button", { name: /Make the change/ }).textContent).toContain("Planned");
});

test("a deck without plan approval starts dealing straight away", async () => {
  await openNew();
  const form = await screen.findByRole("form", { name: "New offshift" });

  await userEvent.type(within(form).getByLabelText("Goal"), "Cache model lists per account.");
  await userEvent.click(within(form).getByRole("switch"));
  fireEvent.keyDown(within(form).getByLabelText("Goal"), { key: "Enter", metaKey: true });

  await screen.findByRole("heading", { level: 1, name: "Cache model lists per account" });
  expect(screen.queryByRole("region", { name: "Offshift plan needs your approval" })).toBeNull();
  expect(screen.getByRole("button", { name: /Map the current behaviour/ }).textContent).toContain(
    "Working",
  );
});

test("a goal too short to plan from is refused with a reason", async () => {
  await openNew();
  const form = await screen.findByRole("form", { name: "New offshift" });

  await userEvent.type(within(form).getByLabelText("Goal"), "Fix it");
  await userEvent.click(within(form).getByRole("button", { name: /Start offshift/ }));

  expect((await within(form).findByRole("alert")).textContent).toBe(
    "Describe the goal in a sentence or two.",
  );
  expect(screen.getByRole("heading", { level: 1, name: "New offshift" })).toBeTruthy();
});

test("⌘⇧N opens New deck from anywhere", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/offshifts/relay-streams");
  await screen.findByRole("heading", { level: 1, name: "Resumable relay streams" });

  await userEvent.keyboard("{Meta>}{Shift>}n{/Shift}{/Meta}");

  expect(await screen.findByRole("form", { name: "New offshift" })).toBeTruthy();
});

test("New deck opens on the goal, and its footer says when lanes start", async () => {
  await openNew();
  const form = await screen.findByRole("form", { name: "New offshift" });
  await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("Goal")));
  expect(within(form).getByText("You approve the plan before any lane starts.")).toBeTruthy();

  await userEvent.click(within(form).getByRole("switch"));

  expect(within(form).getByText("Lanes start as soon as the plan is drafted.")).toBeTruthy();
});

test("a failed submit focuses the field to fix", async () => {
  await openNew();
  const form = await screen.findByRole("form", { name: "New offshift" });
  await userEvent.click(within(form).getByRole("button", { name: /Start offshift/ }));
  await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("Goal")));
});

test("the budget and a time limit are set under Advanced and go to the daemon with the deck", async () => {
  await openNew();
  const form = await screen.findByRole("form", { name: "New offshift" });
  await userEvent.type(
    within(form).getByLabelText("Goal"),
    "Index thread titles for search across every project.",
  );
  await userEvent.click(within(form).getByRole("button", { name: "Advanced" }));
  const budget = within(form).getByLabelText("Lane starts budget");
  // Empty means the default for the lanes at once: 3 lanes × 4 × 6.
  expect(budget.getAttribute("placeholder")).toBe("72");
  await userEvent.type(budget, "0");
  await userEvent.click(within(form).getByRole("button", { name: /Start offshift/ }));
  expect((await within(form).findByRole("alert")).textContent).toBe(
    "Enter a whole number of lane starts, from 1 to 100,000.",
  );
  await waitFor(() => expect(document.activeElement).toBe(budget));

  await userEvent.clear(budget);
  await userEvent.type(budget, "120");
  await userEvent.click(within(form).getByRole("button", { name: /Start offshift/ }));

  await screen.findByRole("heading", { level: 1, name: /^Index thread titles/ });
  expect(screen.getByText("1 of 120 lane starts")).toBeTruthy();
});

test("with no project yet, New deck offers to add one and won't start", async () => {
  const app = harness();
  await app.open("/offshifts/new");
  const form = await screen.findByRole("form", { name: "New offshift" });

  expect(within(form).getByRole("button", { name: "Add project…" })).toBeTruthy();
  expect(within(form).getByText("Offshifts run inside a project.")).toBeTruthy();
  expect(
    within(form)
      .getByRole("button", { name: /Start offshift/ })
      .hasAttribute("disabled"),
  ).toBe(true);
});

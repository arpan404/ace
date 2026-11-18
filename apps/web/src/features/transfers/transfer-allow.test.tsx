import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { continueOn, linkedMachines } from "./transfer-fixture.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** The laptop's record of this Mac's link: the device Allow projects changes there. */
const linkOnLaptop = (fixture: ReturnType<typeof linkedMachines>) =>
  fixture.machine("laptop").access.get("fleet-this-mac-on-laptop");

test("a machine that doesn't allow projects says so, allows them from here, and takes the thread", async () => {
  const fixture = linkedMachines();
  const { app, finish } = fixture;
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));

  expect(
    await within(dialog).findByText("Old laptop doesn't take projects from This Mac yet."),
  ).toBeTruthy();
  const allow = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: "Allow projects on Old laptop",
  });
  await waitFor(() => expect(allow.disabled).toBe(false));
  await userEvent.click(allow);

  // The laptop's own record of this Mac's link now holds Projects; nothing paired again.
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Continue on Old laptop" }),
  );
  expect(linkOnLaptop(fixture)?.scopes).toContain("projects");
  await finish();
  expect(await within(dialog).findByText("Continued on Old laptop")).toBeTruthy();
  expect(
    fixture
      .machine("laptop")
      .projects.list()
      .workspaces.map((each) => each.name),
  ).toEqual(["weather"]);
}, 30_000);

test("a window that can't manage that machine is sent to its Fleet page instead", async () => {
  const fixture = linkedMachines();
  const { app } = fixture;
  fixture.machine("laptop").refuseRequests("forbidden", "fleet.request");
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Old laptop" }));

  expect(
    await within(dialog).findByText(
      "Old laptop doesn't take projects from This Mac yet; allow them on Old laptop in Settings › Fleet.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /^Allow projects/ })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Open Settings › Fleet" }));
  expect(await screen.findByRole("heading", { name: "Old laptop", level: 2 })).toBeTruthy();
  expect(linkOnLaptop(fixture)?.scopes).not.toContain("projects");
}, 30_000);

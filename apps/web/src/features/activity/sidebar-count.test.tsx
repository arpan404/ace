import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Activity's Needs you tab counts all pending thread requests", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/activity");
  // Three threads wait on an answer.
  expect(await screen.findByRole("tab", { name: "Needs you 3" })).toBeTruthy();
});

test("while threads wait on the person, the sidebar's needs-you row opens Activity", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/");
  const sidebar = await screen.findByRole("complementary", { name: "Threads" });
  await userEvent.click(
    await within(sidebar).findByRole("link", { name: /^Activity: \d+ needs? you$/ }),
  );
  expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
  expect(await screen.findByRole("tab", { name: "Needs you 3" })).toBeTruthy();
});

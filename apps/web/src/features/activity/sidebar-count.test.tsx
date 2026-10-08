import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the sidebar and Activity header count the same pending thread requests", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/activity");
  const header = await screen.findByRole("banner");
  const views = screen.getByRole("navigation", { name: "App" });
  // Three threads wait on an answer.
  expect(await within(header).findByText("3 need you")).toBeTruthy();
  expect(within(views).getByLabelText("3 need you")).toBeTruthy();
});

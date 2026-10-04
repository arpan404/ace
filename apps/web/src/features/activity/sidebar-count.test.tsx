import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the sidebar's Activity count is what the Activity header counts, Deck decisions included", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/activity");
  const header = await screen.findByRole("banner");
  const views = screen.getByRole("navigation", { name: "Views" });
  // Three threads wait on an answer; one deck waits on its plan, the other on an escalation and
  // a worker's question. A deck's own threads aren't counted again for the same decisions.
  expect(await within(header).findByText("6 need you")).toBeTruthy();
  expect(within(views).getByLabelText("6 need you")).toBeTruthy();
});

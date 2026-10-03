import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the rail badge counts what the Activity header counts, Deck escalations included", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/activity");
  const header = await screen.findByRole("banner");
  const rail = screen.getByRole("navigation", { name: "Views" });
  // Three threads wait on an answer and one Deck lane escalated.
  expect(await within(header).findByText("4 need you")).toBeTruthy();
  expect(within(rail).getByLabelText("4 need you")).toBeTruthy();
});

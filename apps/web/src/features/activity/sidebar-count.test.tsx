import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen } from "@testing-library/react";
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

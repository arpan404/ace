import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Home shows a hint until a thread is opened, then comes back to that thread", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  expect(await screen.findByText("Pick a thread")).toBeTruthy();

  const threads = await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /Backpressure/ }));
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });

  await userEvent.click(screen.getByRole("link", { name: /^Activity/ }));
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  await userEvent.click(screen.getByRole("link", { name: "Home" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" }),
  ).toBeTruthy();
});

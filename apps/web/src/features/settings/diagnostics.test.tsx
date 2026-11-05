import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the window's connection sits on Fleet, not General, and daemon diagnostics stay under Advanced", async () => {
  const app = harness();
  let view = await app.open("/settings/remote");
  const daemon = await screen.findByRole("region", { name: "In this window" });
  expect(within(daemon).getByText("Computer connection")).toBeTruthy();
  expect(within(daemon).queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(screen.queryByRole("table", { name: "Daemon queues" })).toBeNull();
  view.unmount();

  view = await app.open("/settings/general");
  await screen.findByRole("heading", { name: "General", level: 2 });
  expect(screen.queryByText("Computer connection")).toBeNull();
  view.unmount();

  await app.open("/settings/advanced");
  expect(await screen.findByRole("region", { name: "Health" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Connection" })).toBeNull();
  const show = await screen.findByRole("button", { name: "Show" });
  expect(screen.queryByText("Memory")).toBeNull();
  await userEvent.click(show);
  const health = screen.getByRole("region", { name: "Health" });
  expect(await within(health).findByText("Memory")).toBeTruthy();
  expect(within(health).getByRole("table", { name: "Pending work" })).toBeTruthy();
  expect(within(health).getByRole("button", { name: "Copy diagnostics" })).toBeTruthy();
});

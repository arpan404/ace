import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("daemon diagnostics and the development daemon stay off General, under Advanced", async () => {
  const app = harness();
  const view = await app.open("/settings/general");
  expect(await screen.findByRole("region", { name: "Threads" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Daemon" })).toBeNull();
  expect(screen.queryByText("Fake daemon (development)")).toBeNull();
  expect(screen.queryByRole("table", { name: "Daemon queues" })).toBeNull();
  view.unmount();

  await app.open("/settings/advanced");
  const daemon = await screen.findByRole("region", { name: "Daemon" });
  expect(within(daemon).getByText("Fake daemon (development)")).toBeTruthy();
  const show = await screen.findByRole("button", { name: "Show" });
  expect(screen.queryByText("Memory")).toBeNull();
  await userEvent.click(show);
  const health = screen.getByRole("region", { name: "Health" });
  expect(await within(health).findByText("Memory")).toBeTruthy();
  expect(within(health).getByRole("table", { name: "Daemon queues" })).toBeTruthy();
  expect(within(health).getByRole("button", { name: "Copy diagnostics" })).toBeTruthy();
});

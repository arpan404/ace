import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("daemon diagnostics stay off General and open on request under Advanced", async () => {
  const app = harness();
  const view = await app.open("/settings/general");
  expect(await screen.findByRole("region", { name: "Daemon" })).toBeTruthy();
  expect(screen.queryByRole("table", { name: "Daemon queues" })).toBeNull();
  view.unmount();

  await app.open("/settings/advanced");
  const show = await screen.findByRole("button", { name: "Show" });
  expect(screen.queryByText("Memory")).toBeNull();
  await userEvent.click(show);
  const advanced = screen.getByRole("region", { name: "Advanced" });
  expect(await within(advanced).findByText("Memory")).toBeTruthy();
  expect(within(advanced).getByRole("table", { name: "Daemon queues" })).toBeTruthy();
});

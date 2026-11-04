import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("turning off simulators and emulators in Settings asks first, then saves it for the machine", async () => {
  const app = harness();
  await app.open("/settings/devices");
  const toggle = await screen.findByRole("switch", { name: "Use simulators and emulators" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

  await userEvent.click(toggle);
  const ask = await screen.findByRole("dialog", { name: "Turn off simulators and emulators?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  await userEvent.click(toggle);
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn off" }),
  );
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

  // Turning them back on needs no question.
  await userEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the emulator window choice lives with the devices, not under Computer use", async () => {
  await harness().open("/settings/devices");
  expect(await screen.findByRole("switch", { name: "Show emulator window" })).toBeTruthy();
});

test("Computer use no longer carries the simulator and emulator settings", async () => {
  await harness().open("/settings/computer-use");
  await screen.findByText("Permissions");
  expect(screen.queryByRole("switch", { name: "Show emulator window" })).toBeNull();
  expect(screen.queryByText("Simulators and emulators")).toBeNull();
});

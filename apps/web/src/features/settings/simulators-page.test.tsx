import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("turning off simulators and emulators in Settings asks first, then saves it for the machine", async () => {
  const app = harness();
  await app.open("/settings/simulators");
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

test("Show emulator window starts off, lives with the simulators, and the person's choice is what the daemon keeps", async () => {
  const app = harness();
  await app.open("/settings/simulators");
  const toggle = await screen.findByRole("switch", { name: "Show emulator window" });
  await waitFor(() => expect(toggle.getAttribute("aria-disabled")).not.toBe("true"));
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(toggle);
  await waitFor(() =>
    expect(app.daemon.services.settings.get("devices.emulatorWindow")).toBe(true),
  );
  await userEvent.click(toggle);
  await waitFor(() =>
    expect(app.daemon.services.settings.get("devices.emulatorWindow")).toBe(false),
  );
});

test("Computer use no longer carries the simulator and emulator settings", async () => {
  await harness().open("/settings/computer-use");
  await screen.findByText("Permissions");
  expect(screen.queryByRole("switch", { name: "Show emulator window" })).toBeNull();
  expect(screen.queryByText("Simulators and emulators")).toBeNull();
});

test("Simulators lists the tools simulators need, and a missing one says how to get it", async () => {
  await harness().open("/settings/simulators");
  const tools = within((await screen.findByText("Tools")).closest("section") ?? document.body);
  expect(await tools.findByText("iOS Simulator")).toBeTruthy();
  expect(tools.getByText("Simulator streaming")).toBeTruthy();
  expect(tools.queryByText("Git")).toBeNull();
  expect(tools.getByText("Not installed")).toBeTruthy();
  expect(tools.getByRole("link", { name: "Install Android Studio" })).toBeTruthy();
});

test("Git's status moves to Source control", async () => {
  await harness().open("/settings/source-control");
  const tools = within(
    (await screen.findByText("Tools on this machine")).closest("section") ?? document.body,
  );
  expect(await tools.findByText("Git")).toBeTruthy();
  expect(tools.queryByText("iOS Simulator")).toBeNull();
});

test("this window's simulator choices apply at once, and Clear empties Recent", async () => {
  localStorage.setItem("ace.devices.recent", JSON.stringify([{ id: "ios:iPhone", at: 1 }]));
  localStorage.removeItem("ace.devices.screen-only");
  await harness().open("/settings/simulators");
  const frame = await screen.findByRole("switch", { name: "Show device frame" });
  expect(frame.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(frame);
  await waitFor(() => expect(frame.getAttribute("aria-checked")).toBe("false"));
  expect(localStorage.getItem("ace.devices.screen-only")).toBe("true");

  const clear = screen.getByRole("button", { name: "Clear" });
  await userEvent.click(clear);
  await waitFor(() => expect(clear.hasAttribute("disabled")).toBe(true));
  expect(screen.getByText(/Nothing under Recent yet/)).toBeTruthy();
});

import type { DeviceChrome } from "@ace/protocol";
import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevices } from "@/test/device-browser.ts";

let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
const model = "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro";
/** A body around the fake picture's 390 × 844 screen. */
const look: DeviceChrome = {
  body: { width: 434, height: 888, image: svg },
  screen: { x: 22, y: 22, width: 390, height: 844 },
  buttons: [],
};

test("running tiles wear the real body, and a list of one model asks the daemon for it once", async () => {
  const { app, panel } = await openDevices();
  const devices = app.daemon.appDevices;
  devices.chromes.set(model, look);
  act(() => {
    // Two booted Simulators of the same model, as a person running several iPhone 16 Pros.
    for (const [suffix, id] of [
      ["A", "ios:11111111-2222-4333-8444-555555555555"],
      ["B", "ios:66666666-7777-4888-9999-aaaaaaaaaaaa"],
    ] as const)
      devices.addDevice({
        id,
        platform: "ios",
        name: `iPhone 16 Pro (${suffix})`,
        state: "booted",
        runtime: "iOS 18.4",
        model,
      });
  });
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const running = await within(panel).findByRole("list", { name: "Running devices" });

  await waitFor(() => expect(running.querySelectorAll("[data-device-chrome]").length).toBe(2));
  // One ask covers both (the fake's own iPhone names no model, so it is asked for itself).
  const sameModel = devices.chromeAsks.filter((id) => !id.startsWith("ios:7d1b"));
  expect(sameModel).toHaveLength(1);
});

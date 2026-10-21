import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

test("an emulator's side buttons press its keys as soon as its screen is live", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  await within(pixel).findByRole("img", { name: "Pixel 9 screen" });

  await userEvent.click(within(pixel).getByRole("button", { name: "Volume up" }));
  await userEvent.click(within(pixel).getByRole("button", { name: "Volume down" }));
  await userEvent.click(within(pixel).getByRole("button", { name: "Power button" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "volumeUp" },
      { kind: "key", key: "volumeDown" },
      { kind: "key", key: "power" },
    ]),
  );
});

test("a live iPhone's Action and Side buttons press Action and power, with no control step first", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

  await userEvent.click(within(iphone).getByRole("button", { name: "Action button" }));
  await userEvent.click(within(iphone).getByRole("button", { name: "Side button" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "action" },
      { kind: "key", key: "power" },
    ]),
  );
});

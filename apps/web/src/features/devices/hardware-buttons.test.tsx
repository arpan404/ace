import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices, unusable } from "@/test/device-browser.ts";

let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

test("an emulator's side buttons press its keys while you're in control, and say why not once you hand it back", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await within(pixel).findByRole("status", { name: "You're in control" });

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

  await userEvent.click(within(pixel).getByRole("button", { name: /Hand back/ }));
  const volume = within(pixel).getByRole("button", { name: "Volume up" });
  await waitFor(() => expect(unusable(volume)).toBe(true));
  await userEvent.hover(volume);
  expect((await screen.findByRole("tooltip")).textContent).toBe("Take control to use the device");
  await userEvent.click(volume);
  expect(app.daemon.appDevices.inputs).toHaveLength(3);
});

test("a watched iPhone's Action button does nothing until you take control, then presses Action", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

  const action = within(iphone).getByRole("button", { name: "Action button" });
  await userEvent.click(action);
  expect(app.daemon.appDevices.inputs).toEqual([]);

  await userEvent.click(within(iphone).getByRole("button", { name: /Take control/ }));
  await waitFor(() => expect(unusable(action)).toBe(false));
  await userEvent.click(action);
  await userEvent.click(within(iphone).getByRole("button", { name: "Side button" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "action" },
      { kind: "key", key: "power" },
    ]),
  );
});

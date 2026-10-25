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

const svg = (body: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`)}`;

test("an iPhone wears the body Xcode draws for it, and that body's buttons press its keys", async () => {
  const { app, panel } = await openDevices();
  // A body around a 390 × 844 screen, the fake picture's size, with its volume-up and side
  // buttons where the chrome puts them, and a ring switch ace can't press.
  app.daemon.appDevices.chromes.set("ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b", {
    body: { width: 434, height: 888, image: svg("<rect/>") },
    screen: { x: 22, y: 22, width: 390, height: 844 },
    mask: svg("<rect width='390' height='844' rx='50'/>"),
    buttons: [
      {
        name: "volume-up",
        title: "Volume Up",
        rect: { x: -8, y: 221, width: 16, height: 72 },
        image: svg("<rect/>"),
        onTop: false,
      },
      {
        name: "power",
        title: "Sleep/Wake",
        rect: { x: 426, y: 262, width: 16, height: 117 },
        image: svg("<rect/>"),
        onTop: false,
      },
      {
        name: "mute",
        rect: { x: -8, y: 143, width: 16, height: 32 },
        image: svg("<rect/>"),
        onTop: false,
      },
    ],
  });
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

  await waitFor(() => expect(iphone.querySelector("[data-device-chrome]")).not.toBeNull());
  const screen = iphone.querySelector<HTMLElement>("[data-device-screen]");
  expect(screen?.style.maskImage).toContain("data:image/svg+xml");
  // Only what ace can press is a button: the ring switch is drawn, not offered.
  expect(within(iphone).queryByRole("button", { name: "Ring/Silent switch" })).toBeNull();
  await userEvent.click(within(iphone).getByRole("button", { name: "Volume up" }));
  await userEvent.click(within(iphone).getByRole("button", { name: "Side button" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "volumeUp" },
      { kind: "key", key: "power" },
    ]),
  );
});

test("a device the SDK doesn't describe keeps the drawn frame", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

  expect(iphone.querySelector("[data-device-frame]")).not.toBeNull();
  expect(iphone.querySelector("[data-device-chrome]")).toBeNull();
});

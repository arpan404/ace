import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

const iphoneId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

async function liveIphone(fold?: "open") {
  const { app, panel } = await openDevices();
  if (fold) app.daemon.appDevices.folds.set(iphoneId, fold);
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  return { app, iphone };
}

const pressed = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("button", { name }).getAttribute("aria-pressed");

test("a foldable device's rail shows its posture and folds it when a person picks another", async () => {
  const { app, iphone } = await liveIphone("open");
  const rail = within(iphone).getByRole("toolbar", { name: "Device controls" });
  await waitFor(() => expect(pressed(rail, "Open flat")).toBe("true"));
  expect(pressed(rail, "Closed")).toBe("false");
  expect(pressed(rail, "Half open")).toBe("false");

  await userEvent.click(within(rail).getByRole("button", { name: "Closed" }));
  await waitFor(() => expect(app.daemon.appDevices.folds.get(iphoneId)).toBe("closed"));
  await waitFor(() => expect(pressed(rail, "Closed")).toBe("true"));
  expect(pressed(rail, "Open flat")).toBe("false");

  await userEvent.click(within(rail).getByRole("button", { name: "Half open" }));
  await waitFor(() => expect(app.daemon.appDevices.folds.get(iphoneId)).toBe("partiallyOpen"));
});

test("a device that doesn't fold has no posture buttons", async () => {
  const { iphone } = await liveIphone();
  const rail = within(iphone).getByRole("toolbar", { name: "Device controls" });
  expect(within(rail).getByRole("button", { name: "Rotate" })).toBeTruthy();
  for (const name of ["Closed", "Half open", "Open flat"])
    expect(within(rail).queryByRole("button", { name })).toBeNull();
});

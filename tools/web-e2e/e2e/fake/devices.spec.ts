import { expect, test } from "@playwright/test";

/** The Devices tab against the fake daemon's simulators and emulators. */
test("enabling devices lists them, and a device is approved for the thread and watched live", async ({
  page,
}) => {
  await page.goto("/t/thread-install-page");
  await page.getByRole("button", { name: "Right panel" }).click();
  const panel = page.getByRole("region", { name: "Thread panel" });
  await panel.getByRole("tab", { name: "Devices" }).click();
  await panel.getByRole("button", { name: "Enable devices" }).click();

  const devices = panel.getByRole("list", { name: "Devices" });
  await expect(devices.getByRole("button", { name: /iPhone 16 Pro/ })).toBeVisible();
  await expect(devices.getByRole("button", { name: /Pixel 9/ })).toBeVisible();

  const phone = panel.getByRole("region", { name: "iPhone 16 Pro" });
  await expect(phone).toContainText("Agents in this thread can't use it yet");
  await phone.getByRole("button", { name: "Approve" }).click();
  await expect(phone).not.toContainText("can't use it yet");

  await phone.getByRole("button", { name: "Start live view" }).click();
  await expect(phone.getByRole("img", { name: "iPhone 16 Pro screen" })).toBeVisible();
});

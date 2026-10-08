import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";
let browser: ReturnType<typeof deviceBrowser>;
const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  browser = deviceBrowser("none");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
  URL.createObjectURL = urls.create;
  URL.revokeObjectURL = urls.revoke;
});
async function live() {
  const result = await openDevices();
  await userEvent.click(
    await within(result.panel).findByRole("button", { name: "Enable devices" }),
  );
  const device = await openDevice(result.panel, "iPhone 16 Pro");
  await userEvent.click(within(device).getByRole("button", { name: "Approve" }));
  await within(device).findByRole("img", { name: "iPhone 16 Pro screen" });
  return { ...result, device };
}
async function action(device: HTMLElement, name: string) {
  await userEvent.click(within(device).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
for (const entry of [
  {
    name: "Install app…",
    field: "App package path",
    value: "/tmp/build/MyApp.app",
    expected: { op: "install", path: "/tmp/build/MyApp.app" },
  },
  {
    name: "Open URL…",
    field: "URL",
    value: "https://example.com",
    expected: { op: "open_url", url: "https://example.com" },
  },
  {
    name: "Open app…",
    field: "App identifier",
    value: "dev.example.app",
    expected: { op: "open_app", appId: "dev.example.app" },
  },
])
  test(`${entry.name} sends the entered value to the selected device`, async () => {
    const { app, device } = await live();
    await action(device, entry.name);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: entry.field }), entry.value);
    await userEvent.click(
      within(dialog).getByRole("button", { name: entry.name.replace("…", "") }),
    );
    await waitFor(() =>
      expect(app.daemon.appDevices.actions).toEqual([expect.objectContaining(entry.expected)]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
test("device settings apply appearance, locale and location", async () => {
  const { app, device } = await live();
  await action(device, "Device settings…");
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("combobox", { name: "Appearance" }));
  await userEvent.click(await screen.findByRole("option", { name: "Dark" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Locale" }), "fr-FR");
  await userEvent.type(within(dialog).getByRole("spinbutton", { name: "Latitude" }), "48.85");
  await userEvent.type(within(dialog).getByRole("spinbutton", { name: "Longitude" }), "2.35");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.actions).toEqual([
      expect.objectContaining({
        op: "configure",
        settings: {
          appearance: "dark",
          locale: "fr-FR",
          location: { latitude: 48.85, longitude: 2.35 },
        },
      }),
    ]),
  );
});
test("invalid location stays in the form with a fix", async () => {
  const { app, device } = await live();
  await action(device, "Device settings…");
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByRole("spinbutton", { name: "Latitude" }), "95");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Enter both latitude and longitude",
  );
  expect(app.daemon.appDevices.actions).toEqual([]);
});
test("opening Simulator leaves computer use off; approval is scoped to the thread and Revoke removes it", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const device = await openDevice(panel, "iPhone 16 Pro");
  expect(app.daemon.screen.access.enabled).toBe(false);
  expect(app.daemon.screen.access.list()).toEqual([]);
  expect(within(device).getByText(/You can watch without approving/)).toBeTruthy();
  expect(await within(device).findByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
  expect(app.daemon.screen.access.list()).toEqual([]);
  await userEvent.click(within(device).getByRole("button", { name: "Approve" }));
  await within(device).findByRole("img", { name: "iPhone 16 Pro screen" });
  expect(app.daemon.screen.access.list()).toEqual([
    expect.objectContaining({
      bundleId: "com.apple.iphonesimulator",
      scope: "thread",
      threadId: "thread-checkout",
    }),
  ]);
  await userEvent.click(within(device).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(app.daemon.screen.access.list()).toEqual([]));
});
test("failed log startup shows Retry in place and retry opens logs", async () => {
  const { app, device } = await live();
  app.daemon.appDevices.logsFail = true;
  await userEvent.click(within(device).getByRole("button", { name: "Logs" }));
  const error = await within(device).findByRole("alert");
  expect(error.textContent).toContain("Couldn't start device logs");
  app.daemon.appDevices.logsFail = false;
  await userEvent.click(within(error).getByRole("button", { name: "Retry" }));
  expect(await within(device).findByText(/SpringBoard launched/)).toBeTruthy();
  expect(within(device).queryByRole("alert")).toBeNull();
});
test("stopping recording posts a playable video to the thread", async () => {
  const { device } = await live();
  URL.createObjectURL = () => "blob:test/recording";
  URL.revokeObjectURL = () => {};
  await action(device, "Record");
  await action(device, "Stop recording");
  await userEvent.click(await screen.findByRole("button", { name: "Play recording" }));
  const dialog = await screen.findByRole("dialog", { name: "Device recording.mp4" });
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Device recording.mp4").getAttribute("src")).toBe(
      "blob:test/recording",
    ),
  );
  expect(within(dialog).getByLabelText("Device recording.mp4").hasAttribute("controls")).toBe(true);
});
test("Screenshot saves a fresh JPEG from the selected device", async () => {
  const { device } = await live();
  const downloads: string[] = [];
  const blobs: Blob[] = [];
  URL.createObjectURL = (blob) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:test/shot";
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  await action(device, "Screenshot");
  await waitFor(() => expect(downloads).toEqual(["iPhone 16 Pro.jpg"]));
  expect(blobs[0]?.type).toBe("image/jpeg");
  expect(blobs[0]?.size).toBeGreaterThan(0);
});

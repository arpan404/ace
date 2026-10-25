import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";
let browser: ReturnType<typeof deviceBrowser>;
const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  browser = deviceBrowser("decodes");
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
test("appearance, location and language each apply to the device from its menu", async () => {
  const { app, device } = await live();
  await userEvent.click(within(device).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Appearance" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

  await action(device, "Location…");
  const location = await screen.findByRole("dialog");
  await userEvent.type(within(location).getByRole("spinbutton", { name: "Latitude" }), "48.85");
  await userEvent.type(within(location).getByRole("spinbutton", { name: "Longitude" }), "2.35");
  await userEvent.click(within(location).getByRole("button", { name: "Set location" }));

  await action(device, "Language and region…");
  const language = await screen.findByRole("dialog");
  await userEvent.type(within(language).getByRole("textbox", { name: "Locale" }), "fr-FR");
  await userEvent.click(within(language).getByRole("button", { name: "Set language" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.actions).toEqual([
      expect.objectContaining({ op: "configure", settings: { appearance: "dark" } }),
      expect.objectContaining({
        op: "configure",
        settings: { location: { latitude: 48.85, longitude: 2.35 } },
      }),
      expect.objectContaining({ op: "configure", settings: { locale: "fr-FR" } }),
    ]),
  );
});
test("the App drawer installs, launches and opens a link on the device", async () => {
  const { app, device } = await live();
  await userEvent.click(within(device).getByRole("button", { name: "App" }));
  const drawer = within(device).getByRole("region", { name: "Device details" });
  await userEvent.type(within(drawer).getByRole("textbox", { name: "Install" }), "/tmp/My.app");
  await userEvent.click(within(drawer).getByRole("button", { name: "Install" }));
  await userEvent.type(within(drawer).getByRole("textbox", { name: "Launch" }), "dev.example");
  await userEvent.click(within(drawer).getByRole("button", { name: "Launch" }));
  await userEvent.type(within(drawer).getByRole("textbox", { name: "Open URL" }), "not a url");
  await userEvent.click(within(drawer).getByRole("button", { name: "Open" }));
  expect((await within(drawer).findByRole("alert")).textContent).toContain("complete URL");
  await waitFor(() =>
    expect(app.daemon.appDevices.actions).toEqual([
      expect.objectContaining({ op: "install", path: "/tmp/My.app" }),
      expect.objectContaining({ op: "open_app", appId: "dev.example" }),
    ]),
  );
});
test("invalid location stays in the form with a fix", async () => {
  const { app, device } = await live();
  await action(device, "Location…");
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByRole("spinbutton", { name: "Latitude" }), "95");
  await userEvent.click(within(dialog).getByRole("button", { name: "Set location" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Enter both latitude and longitude",
  );
  expect(app.daemon.appDevices.actions).toEqual([]);
});
test("watching Simulator leaves computer use off", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const device = await openDevice(panel, "iPhone 16 Pro");
  expect(await within(device).findByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
  expect(app.daemon.screen.enabled).toBe(false);
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
  // The rail's Record shows how long it has run, and stops it again.
  await userEvent.click(within(device).getByRole("button", { name: "Record" }));
  expect(await within(device).findByRole("timer", { name: "Recording time" })).toBeTruthy();
  await userEvent.click(within(device).getByRole("button", { name: "Stop recording" }));
  await userEvent.click(await screen.findByRole("button", { name: "Play recording" }));
  const dialog = await screen.findByRole("dialog", { name: "Device recording.mp4" });
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Device recording.mp4").getAttribute("src")).toBe(
      "blob:test/recording",
    ),
  );
  expect(within(dialog).getByLabelText("Device recording.mp4").hasAttribute("controls")).toBe(true);
});
test("Copy screenshot puts the device's screen on the clipboard as a PNG, with no download", async () => {
  const { device } = await live();
  const clipboard: Blob[] = [];
  // jsdom has no clipboard or PNG encoder: these stand in for the browser's, at its boundary.
  class Item {
    items: Record<string, Promise<Blob>>;
    constructor(items: Record<string, Promise<Blob>>) {
      this.items = items;
    }
  }
  vi.stubGlobal("ClipboardItem", Item);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: Item[]) => {
        for (const item of items) {
          const png = item.items["image/png"];
          if (png) clipboard.push(await png);
        }
      },
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
    done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
  );
  const downloads = vi.spyOn(HTMLAnchorElement.prototype, "click");

  await userEvent.click(within(device).getByRole("button", { name: "Copy screenshot" }));

  expect(await screen.findByText("Screenshot copied")).toBeTruthy();
  expect(clipboard.map((blob) => blob.type)).toEqual(["image/png"]);
  expect(downloads).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, "clipboard");
});

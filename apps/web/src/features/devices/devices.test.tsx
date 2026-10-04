import { flakyCheckout } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

// jsdom has no object URLs; each frame gets a distinct address the way a browser's would.
beforeEach(() => {
  let urls = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => `blob:frame-${++urls}`,
      revokeObjectURL: () => {},
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function openDevices() {
  // Control leases expire on the daemon's clock; here it is the page's.
  const app = harness({ clock: () => Date.now() });
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  await app.open("/t/thread-checkout");
  // ⌃⇧M opens the Devices tool in the side panel.
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Devices", selected: true })).toBeTruthy();
  return { app, panel };
}

/** Open a device from the catalog as its own tab; its region once loaded. */
async function openDevice(panel: HTMLElement, name: string) {
  const list = await within(panel).findByRole("list", { name: "Devices" });
  await userEvent.click(within(list).getByRole("button", { name: new RegExp(`^${name}`) }));
  return within(panel).findByRole("region", { name });
}

/** The line at the top of a device's tab: "<device> · <what it is doing>". */
const statusLine = (section: HTMLElement) =>
  within(section).getByText(
    (_, element) => element?.tagName === "P" && /·/.test(element.textContent ?? ""),
  ).textContent;

test("devices stay off until enabled, then list the simulator and emulator", async () => {
  const { panel } = await openDevices();

  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));

  const list = await within(panel).findByRole("list", { name: "Devices" });
  const rows = within(list).getAllByRole("button");
  expect(rows[0]?.textContent).toMatch(/^iPhone 16 Pro.*iOS 18\.4 · Running$/);
  expect(rows[1]?.textContent).toMatch(/^Pixel 9.*Android 15 · Off$/);
  expect(rows).toHaveLength(2);
});

test("approving a device for the thread is what the daemon records", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));

  expect(await within(iphone).findByText("Agents in this thread can use it")).toBeTruthy();
  expect(app.daemon.appDevices.approval("ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b")).toBe(
    "thread-checkout",
  );
});

test("an emulator boots, streams its screen, and takes keys and text once you take control", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");

  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  await userEvent.click(await within(pixel).findByRole("button", { name: "Start live view" }));

  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await waitFor(() => expect(screenImage.getAttribute("src")).toMatch(/^blob:frame-/));
  expect(statusLine(pixel)).toBe("Pixel 9 · Live · You're in control");

  await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
  await userEvent.type(within(pixel).getByRole("textbox", { name: "Type on the device" }), "hello");
  await userEvent.click(within(pixel).getByRole("button", { name: "Send" }));

  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "back" },
      { kind: "type", text: "hello" },
    ]),
  );

  await userEvent.click(within(pixel).getByRole("button", { name: /Hand back/ }));
  await waitFor(() =>
    expect(within(pixel).getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true),
  );
});

test("without control the live screen only watches: keys stay off", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

  await userEvent.click(within(iphone).getByRole("button", { name: "Start live view" }));

  expect(await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
  expect(within(iphone).getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(true);

  // The control bar over the screen hands the device to you, and back.
  await userEvent.click(within(iphone).getByRole("button", { name: /Take control/ }));
  await waitFor(() =>
    expect(within(iphone).getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  expect(statusLine(iphone)).toBe("iPhone 16 Pro · Live · You're in control");
});

test("the device's ⋯ menu stops the live view and shuts the device down", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await userEvent.click(within(iphone).getByRole("button", { name: "Start live view" }));
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

  await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Stop live view" }));
  await waitFor(() =>
    expect(within(iphone).queryByRole("img", { name: "iPhone 16 Pro screen" })).toBeNull(),
  );

  await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Shut down" }));
  expect(await within(iphone).findByText("iPhone 16 Pro is off.")).toBeTruthy();
});

test("disabling devices is machine-wide, so it asks first", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

  await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Disable devices…" }));
  const confirm = await screen.findByRole("dialog", { name: "Disable devices on this machine?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(within(panel).queryByRole("button", { name: "Enable devices" })).toBeNull();

  await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Disable devices…" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Disable devices" }),
  );
  expect(await within(panel).findByRole("button", { name: "Enable devices" })).toBeTruthy();
});

test("the device's logs appear while the log section is open", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await openDevice(panel, "iPhone 16 Pro");

  await userEvent.click(await within(panel).findByRole("button", { name: "Logs" }));

  const logs = await within(panel).findByRole("log", { name: "Device logs" });
  expect(await within(logs).findByText(/SpringBoard launched/)).toBeTruthy();
});

test("revoking approval takes the device away from the thread's agents", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));

  await userEvent.click(await within(iphone).findByRole("button", { name: "Revoke" }));

  expect(await within(iphone).findByText("Agents in this thread can't use it yet")).toBeTruthy();
  expect(
    app.daemon.appDevices.approval("ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b"),
  ).toBeUndefined();
});

test("a dropped devices channel says so, and Reconnect opens a fresh one", async () => {
  const { app, panel } = await openDevices();
  await within(panel).findByRole("button", { name: "Enable devices" });

  act(() => app.daemon.appDevices.dropAll());

  expect(await within(panel).findByText("Devices disconnected")).toBeTruthy();
  expect(
    within(panel).getByText(/Lost the connection to this machine's simulators and emulators/),
  ).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Reconnect" }));
  expect(await within(panel).findByRole("button", { name: "Enable devices" })).toBeTruthy();
});

/** Hide or show the page, as switching tabs or minimising the window does. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("while the window is hidden the device screen decodes nothing, and shows the newest frame once shown", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  await userEvent.click(await within(pixel).findByRole("button", { name: "Start live view" }));
  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await waitFor(() => expect(screenImage.getAttribute("src")).toMatch(/^blob:frame-/));

  try {
    visibility("hidden");
    const before = screenImage.getAttribute("src");
    // Each key press repaints the device's screen.
    await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
    await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screenImage.getAttribute("src")).toBe(before);

    act(() => visibility("visible"));
    await waitFor(() => expect(screenImage.getAttribute("src")).not.toBe(before));
  } finally {
    visibility("visible");
  }
});

test("each device opens as its own tab beside the others, and the catalog marks the open ones", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await openDevice(panel, "iPhone 16 Pro");
  expect(within(panel).getByRole("tab", { name: "iPhone 16 Pro", selected: true })).toBeTruthy();

  await userEvent.click(within(panel).getByRole("tab", { name: "Devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  expect(within(panel).getByRole("tab", { name: "Pixel 9", selected: true })).toBeTruthy();
  expect(within(panel).getByRole("tab", { name: "iPhone 16 Pro" })).toBeTruthy();
  expect(within(pixel).getByText("Pixel 9 is off.")).toBeTruthy();

  await userEvent.click(within(panel).getByRole("tab", { name: "Devices" }));
  const list = within(panel).getByRole("list", { name: "Devices" });
  for (const row of within(list).getAllByRole("button")) expect(row.textContent).toContain("Open");
});

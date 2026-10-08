import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

// jsdom has no WebCodecs: every screen here is JPEG, as in a browser without it.
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("none");
});
afterEach(() => browser.restore());

/** Wait until the device's screen has drawn at least one frame. */
async function shows(screenImage: HTMLElement) {
  await waitFor(() => expect(browser.draws(screenImage)).toBeGreaterThan(0));
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

test("a person watches an unapproved simulator; approval removes the access hint", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  const image = await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  await shows(image);
  expect(
    app.daemon.appDevices.approval("ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b"),
  ).toBeUndefined();
  expect(within(iphone).getByText(/You can watch without approving/)).toBeTruthy();
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
  await within(iphone).findByText("Agents in this thread can use it");
  expect(within(iphone).queryByText(/You can watch without approving/)).toBeNull();
});

test("booting an emulator shows its live screen, which takes keys and text while you're in control", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");

  // Booting is how a person asks to see the device: no second step to start the view.
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));

  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await shows(screenImage);
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

test("an approved running simulator shows its screen, and only watches until you take control", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
  const screenImage = await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  await shows(screenImage);
  expect(within(iphone).getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(true);

  // The control bar over the screen hands the device to you, and back.
  await userEvent.click(within(iphone).getByRole("button", { name: /Take control/ }));
  await waitFor(() =>
    expect(within(iphone).getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  expect(statusLine(iphone)).toBe("iPhone 16 Pro · Live · You're in control");
  await userEvent.click(within(iphone).getByRole("button", { name: "Home" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "home" },
    ]),
  );
});

test("the device's ⋯ menu stops the live view and shuts the device down", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
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
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await shows(screenImage);

  try {
    visibility("hidden");
    const drawn = browser.draws(screenImage);
    const decoded = browser.bitmaps.length;
    // Each key press repaints the device's screen; the daemon has both once it records them.
    await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
    await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(app.daemon.appDevices.inputs).toHaveLength(2));
    expect(browser.bitmaps).toHaveLength(decoded);
    expect(browser.draws(screenImage)).toBe(drawn);

    // Shown again, the screen asks for the newest frame and decodes only that one.
    act(() => visibility("visible"));
    await waitFor(() => expect(browser.draws(screenImage)).toBe(drawn + 1));
    expect(browser.bitmaps).toHaveLength(decoded + 1);
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

test("when macOS hasn't allowed screen recording, the simulator tab says how to allow it and shows the screen once allowed", async () => {
  const { app, panel } = await openDevices();
  app.daemon.appDevices.permissions.screenRecording = false;
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
  const guide = await within(iphone).findByRole("alert", {
    name: "Screen Recording permission needed",
  });
  expect(guide.textContent).toContain("Privacy & Security › Screen Recording");
  expect(guide.textContent).toContain("Ace Screen Helper");
  expect(within(iphone).queryByRole("img", { name: "iPhone 16 Pro screen" })).toBeNull();

  await userEvent.click(
    within(guide).getByRole("button", { name: "Open Screen Recording settings" }),
  );
  await waitFor(() => expect(app.daemon.appDevices.requested).toEqual(["screenRecording"]));

  // The person turns it on in System Settings, then comes back.
  app.daemon.appDevices.permissions.screenRecording = true;
  await userEvent.click(within(guide).getByRole("button", { name: "Try again" }));
  const screenImage = await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  await shows(screenImage);
  expect(within(iphone).queryByRole("alert", { name: /permission needed/ })).toBeNull();
});

test("a simulator key refused for want of Accessibility says how to allow it, above the live screen", async () => {
  const { app, panel } = await openDevices();
  app.daemon.appDevices.permissions.accessibility = false;
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

  await userEvent.click(within(iphone).getByRole("button", { name: /Take control/ }));
  await userEvent.click(within(iphone).getByRole("button", { name: "Home" }));

  const guide = await within(iphone).findByRole("alert", {
    name: "Accessibility permission needed",
  });
  expect(guide.textContent).toContain("Privacy & Security › Accessibility");
  expect(within(iphone).getByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
  expect(app.daemon.appDevices.inputs).toEqual([]);
  await userEvent.click(within(guide).getByRole("button", { name: "Open Accessibility settings" }));
  await waitFor(() => expect(app.daemon.appDevices.requested).toEqual(["accessibility"]));
});

test("an approved device can be delegated to one of the thread's agents, who then holds it, and taken back", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
  await within(iphone).findByText("Agents in this thread can use it");

  await userEvent.click(
    await within(iphone).findByRole("button", { name: "Delegate to an agent" }),
  );
  const agents = await screen.findAllByRole("menuitem");
  const chosen = agents[0]?.textContent ?? "";
  await userEvent.click(agents[0]!);

  // The daemon's state names the agent that holds it now.
  expect(await within(iphone).findByText(`${chosen} is using it`)).toBeTruthy();
  expect(statusLine(iphone)).toMatch(/The agent is in control$/);

  await userEvent.click(within(iphone).getByRole("button", { name: "Take back" }));
  expect(await within(iphone).findByText("You're using it")).toBeTruthy();
});

test("Simulator can restart its live view without granting agent access", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await shows(await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" }));
  await userEvent.click(
    within(iphone).getByRole("button", { name: /Device actions|More|iPhone 16 Pro actions/ }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: /Stop live view/ }));
  await userEvent.click(await within(iphone).findByRole("button", { name: "Start live view" }));
  await shows(await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" }));
});

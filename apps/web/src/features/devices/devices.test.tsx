import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices, unusable } from "@/test/device-browser.ts";

function noop() {}
// jsdom has no WebCodecs: a stand-in decoder shows every H.264 picture, as a browser would.
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("decodes");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

/** Wait until the device's screen has drawn at least one frame. */
async function shows(screenImage: HTMLElement) {
  await waitFor(() => expect(browser.draws(screenImage)).toBeGreaterThan(0));
}

/** The line under a device's name: its OS, where it is and, while live, its stream. */
const subtitle = (section: HTMLElement, pattern: RegExp) => within(section).getByText(pattern);

test("devices stay off until enabled, then show the running simulator and every device by kind", async () => {
  const { panel } = await openDevices();

  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));

  // The booted iPhone is running, so it leads as a tile; the Pixel is off.
  const running = await within(panel).findByRole("list", { name: "Running devices" });
  expect(
    within(running)
      .getAllByRole("button")
      .map((tile) => tile.getAttribute("aria-label")),
  ).toEqual(["iPhone 16 Pro, iOS 18.4, Running"]);

  // Every device sits under its kind, folded with a count until opened.
  const all = within(panel).getByRole("region", { name: "All devices" });
  expect(within(all).queryByRole("list", { name: "iPhone" })).toBeNull();
  await userEvent.click(within(all).getByText("iPhone"));
  await userEvent.click(within(all).getByText("Android phone"));
  expect(
    within(within(all).getByRole("list", { name: "iPhone" })).getByRole("button").textContent,
  ).toMatch(/^iPhone 16 Pro.*iOS 18\.4 · Running$/);
  expect(
    within(within(all).getByRole("list", { name: "Android phone" })).getByRole("button")
      .textContent,
  ).toMatch(/^Pixel 9.*Android 15 · Off$/);
});

test("the search and the platform filter narrow the list, and / goes to the search", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const all = await within(panel).findByRole("region", { name: "All devices" });

  await userEvent.click(within(panel).getByRole("button", { name: "Android" }));
  expect(within(panel).queryByRole("list", { name: "Running devices" })).toBeNull();
  expect(within(all).getByRole("list", { name: "Android phone" })).toBeTruthy();
  expect(within(all).queryByText("iPhone")).toBeNull();

  await userEvent.click(within(panel).getByRole("button", { name: "All" }));
  await userEvent.keyboard("/");
  const search = within(panel).getByRole("searchbox", { name: "Search devices" });
  expect(document.activeElement).toBe(search);
  await userEvent.type(search, "watch");
  expect(await within(panel).findByText("No devices match")).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Clear search" }));
  expect(within(panel).getByRole("list", { name: "Running devices" })).toBeTruthy();
});

test("a device opened from the list comes back under Recent, with Boot to start it again", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await openDevice(panel, "Pixel 9");

  await userEvent.click(within(panel).getByRole("tab", { name: "Devices" }));
  const recent = await within(panel).findByRole("list", { name: "Recent devices" });
  const row = within(recent).getByText("Pixel 9").closest("li");
  expect(row?.textContent).toMatch(/Android 15 · used just now/);

  await userEvent.click(within(row!).getByRole("button", { name: "Boot" }));
  const pixel = await within(panel).findByRole("region", { name: "Pixel 9" });
  await shows(await within(pixel).findByRole("img", { name: "Pixel 9 screen" }));
  expect(app.daemon.appDevices.boundThread("android:Pixel_9_API_35")).toBe("thread-checkout");
});

test("booting an emulator shows its live screen, which takes keys and text at once", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");

  // Booting is how a person asks to see the device: no second step to start the view.
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));

  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await shows(screenImage);
  expect(subtitle(pixel, /^Android 15 · Live/)).toBeTruthy();

  // The rail's keys (Software keyboard brings the device's own keyboard back), then the text
  // field Type text opens, which types on the device.
  await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
  await userEvent.click(within(pixel).getByRole("button", { name: "Software keyboard" }));
  expect(within(pixel).queryByRole("textbox", { name: "Type on the device" })).toBeNull();
  await userEvent.click(within(pixel).getByRole("button", { name: "Type text" }));
  await userEvent.type(within(pixel).getByRole("textbox", { name: "Type on the device" }), "hello");
  await userEvent.click(within(pixel).getByRole("button", { name: "Send" }));

  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "back" },
      { kind: "key", key: "keyboard" },
      { kind: "type", text: "hello" },
    ]),
  );
});

test("a running simulator's live screen takes input at once, with no control step first", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

  const screenImage = await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  await shows(screenImage);
  expect(subtitle(iphone, /^iOS 18\.4 · Live/)).toBeTruthy();
  expect(unusable(within(iphone).getByRole("button", { name: "Home" }))).toBe(false);
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

test("the device's logs appear while the drawer shows them, and the filter narrows them", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await openDevice(panel, "iPhone 16 Pro");
  expect(within(panel).queryByRole("log", { name: "Device logs" })).toBeNull();

  await userEvent.click(await within(panel).findByRole("button", { name: "Logs" }));

  const logs = await within(panel).findByRole("log", { name: "Device logs" });
  expect(await within(logs).findByText(/SpringBoard launched/)).toBeTruthy();
  await userEvent.type(within(panel).getByRole("searchbox", { name: "Filter logs" }), "network");
  expect(within(logs).queryByText(/SpringBoard launched/)).toBeNull();
  expect(within(logs).getByText(/Network reachable/)).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: "Fold the drawer" }));
  expect(within(panel).queryByRole("log", { name: "Device logs" })).toBeNull();
});

test("a devices channel the daemon drops comes back by itself", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await within(panel).findByRole("list", { name: "Running devices" });

  act(() => app.daemon.appDevices.dropAll());

  await waitFor(() => expect(app.daemon.appDevices.openChannels).toBe(1));
  expect(await within(panel).findByRole("list", { name: "Running devices" })).toBeTruthy();
  expect(within(panel).queryByText("Devices disconnected")).toBeNull();
});

test("a devices channel dropped while the page is hidden reconnects once the page shows", async () => {
  const { app, panel } = await openDevices();
  await within(panel).findByRole("button", { name: "Enable devices" });

  try {
    visibility("hidden");
    act(() => app.daemon.appDevices.dropAll());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.daemon.appDevices.openChannels).toBe(0);

    act(() => visibility("visible"));
    await waitFor(() => expect(app.daemon.appDevices.openChannels).toBe(1));
    expect(await within(panel).findByRole("button", { name: "Enable devices" })).toBeTruthy();
  } finally {
    visibility("visible");
  }
});

test("a devices channel that can't come back says so, and Reconnect opens a fresh one", async () => {
  const { app, panel } = await openDevices();
  await within(panel).findByRole("button", { name: "Enable devices" });

  app.daemon.appDevices.refusing = true;
  act(() => app.daemon.appDevices.dropAll());

  expect(await within(panel).findByText("Devices disconnected")).toBeTruthy();
  expect(
    within(panel).getByText(/Lost the connection to this machine's simulators and emulators/),
  ).toBeTruthy();
  app.daemon.appDevices.refusing = false;
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
    const decoded = browser.videoFrames.length;
    // Each key press repaints the device's screen; the daemon has both once it records them.
    await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
    await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(app.daemon.appDevices.inputs).toHaveLength(2));
    expect(browser.videoFrames).toHaveLength(decoded);
    expect(browser.draws(screenImage)).toBe(drawn);

    // Shown again, the screen asks for the newest frame and decodes only that one.
    act(() => visibility("visible"));
    await waitFor(() => expect(browser.draws(screenImage)).toBe(drawn + 1));
    expect(browser.videoFrames).toHaveLength(decoded + 1);
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
  await userEvent.clear(within(panel).getByRole("searchbox", { name: "Search devices" }));
  const all = await within(panel).findByRole("region", { name: "All devices" });
  await userEvent.click(within(all).getByText("iPhone"));
  await userEvent.click(within(all).getByText("Android phone"));
  for (const kind of ["iPhone", "Android phone"])
    expect(
      within(within(all).getByRole("list", { name: kind })).getByRole("button").textContent,
    ).toContain("Open");
});

test("when macOS hasn't allowed screen recording, the simulator tab says how to allow it and shows the screen once allowed", async () => {
  const { app, panel } = await openDevices();
  app.daemon.appDevices.permissions.screenRecording = false;
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");

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
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });

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

test("Simulator can restart its live view", async () => {
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

function interceptDeviceRequests(
  app: Awaited<ReturnType<typeof openDevices>>["app"],
  handle: (
    message: import("@ace/protocol").DeviceClientMessage,
    send: (message: import("@ace/protocol").DeviceClientMessage) => void,
    push: (data: unknown) => void,
  ) => boolean,
) {
  const create = app.daemon.appDevices.transport.bind(app.daemon.appDevices);
  return vi.spyOn(app.daemon.appDevices, "transport").mockImplementation(() => {
    const transport = create();
    let push: (data: unknown) => void = noop;
    return {
      ...transport,
      open(events) {
        push = events.message;
        transport.open(events);
      },
      send(message) {
        if (
          message.type === "devices.ack" ||
          !handle(
            message,
            (next) => {
              void transport.send(next);
            },
            push,
          )
        )
          return transport.send(message);
      },
    };
  });
}
test("a device tab says loading during a slow inventory read and then returns to its screen", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await openDevice(panel, "iPhone 16 Pro");
  let resume: (() => void) | undefined;
  const spy = interceptDeviceRequests(app, (message, send) => {
    if (message.operation.op !== "list") return false;
    resume = () => send(message);
    return true;
  });
  // The dropped channel comes back by itself and reads the inventory again.
  act(() => app.daemon.appDevices.dropAll());
  expect(await within(panel).findByLabelText("Loading iPhone 16 Pro")).toBeTruthy();
  expect(within(panel).queryByText(/isn't on this machine any more/)).toBeNull();
  act(() => resume?.());
  expect(await within(panel).findByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
  spy.mockRestore();
});
test("booting has a visible status until the emulator finishes", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  let pixel = await openDevice(panel, "Pixel 9");
  let resume: (() => void) | undefined;
  const spy = interceptDeviceRequests(app, (message, send, push) => {
    if (message.operation.op !== "boot") return false;
    push({
      type: "devices.state",
      state: {
        device: {
          id: "android:Pixel_9_API_35",
          name: "Pixel 9",
          platform: "android",
          state: "shutdown",
        },
        enabled: true,
        lifecycle: "idle",
        booting: true,
        controller: "human",
        leaseExpiresAt: Date.now() + 30000,
      },
    });
    resume = () => send(message);
    return true;
  });
  act(() => app.daemon.appDevices.dropAll());
  pixel = await within(panel).findByRole("region", { name: "Pixel 9" });
  await userEvent.click(within(pixel).getByRole("button", { name: /^Boot$/ }));
  // Said under the name and over the device, with nothing left to press until it is up.
  expect(await within(pixel).findAllByText(/Booting…/)).toHaveLength(2);
  expect(within(pixel).queryByRole("button", { name: /^Boot$/ })).toBeNull();
  act(() => resume?.());
  expect(await within(pixel).findByRole("img", { name: "Pixel 9 screen" })).toBeTruthy();
  spy.mockRestore();
});
test.each(["booted", "shutdown", "offline"] as const)(
  "a failed stop offers cleanup retry while the device is %s",
  async (deviceState) => {
    const { app, panel } = await openDevices();
    await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
    let iphone = await openDevice(panel, "iPhone 16 Pro");
    await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
    let fail = true;
    const spy = interceptDeviceRequests(app, (message, _send, push) => {
      if (message.operation.op !== "stop" || !fail) return false;
      fail = false;
      const error = {
        code: "command_failed",
        message: "Capture cleanup failed",
        hint: "Retry cleanup.",
      };
      push({
        type: "devices.state",
        state: {
          device: {
            id: "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b",
            name: "iPhone 16 Pro",
            platform: "ios",
            state: deviceState,
          },
          enabled: true,
          lifecycle: "failed",
          cleanupRequired: true,
          controller: "none",
          error,
        },
      });
      push({ type: "devices.result", requestId: message.requestId, ok: false, error });
      return true;
    });
    act(() => app.daemon.appDevices.dropAll());
    iphone = await within(panel).findByRole("region", { name: "iPhone 16 Pro" });
    await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
    await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Stop live view" }));
    await within(iphone).findByRole("button", { name: "Retry cleanup" });
    await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Retry cleanup" }));
    await userEvent.click(await within(iphone).findByRole("button", { name: "Start live view" }));
    expect(await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
    spy.mockRestore();
  },
);

test("administrator refusals explain inventory and enable access immediately", async () => {
  const { app, panel } = await openDevices();
  vi.spyOn(app.daemon.appDevices, "transport").mockImplementation(() => {
    let events: Parameters<import("@ace/client/devices").DeviceTransport["open"]>[0] | undefined;
    return {
      open(next) {
        events = next;
        queueMicrotask(() => next.ready());
      },
      send(message) {
        if (message.type === "devices.ack") return;
        events?.message({
          type: "devices.result",
          requestId: message.requestId,
          ok: false,
          error: {
            code: "permission_denied",
            message: "Administrator scope is required for device access",
            hint: "Connect with an administrator device credential to use Devices.",
          },
        });
      },
      close() {},
    };
  });
  act(() => app.daemon.appDevices.dropAll());
  expect(
    await within(panel).findByText("Administrator scope is required for device access"),
  ).toBeTruthy();
  expect(
    within(panel).getByText("Connect with an administrator device credential to use Devices."),
  ).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Enable devices" }));
  expect(
    await within(panel).findByText("Administrator scope is required for device access"),
  ).toBeTruthy();
  expect(within(panel).queryByText(/timed out/i)).toBeNull();
});

test("boot takes this panel's own lease from another connection that holds the device", async () => {
  const { DeviceClient } = await import("@ace/client/devices");
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  let serial = 0;
  const other = new DeviceClient({ id: () => `other-${++serial}`, schedule: () => () => {} });
  other.connect(app.daemon.appDevices.transport());
  try {
    await waitFor(() => expect(other.getSnapshot().connected).toBe(true));
    await act(async () => {
      await other.request({
        op: "controller",
        deviceId: "android:Pixel_9_API_35",
        controller: "human",
      });
    });
    await waitFor(() => expect(subtitle(pixel, /^Android 15 · Off$/)).toBeTruthy());
    await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
    await waitFor(() => expect(subtitle(pixel, /^Android 15 · Live/)).toBeTruthy());
    expect(
      other.getSnapshot().states.find((state) => state.device.id === "android:Pixel_9_API_35")
        ?.ownedHere,
    ).toBe(false);
  } finally {
    other.disconnect();
  }
});

test("Stream stats from the device's ⋯ menu show what arrived and what was drawn over the live screen", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await shows(await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" }));
  expect(within(iphone).queryByRole("list", { name: "Stream stats" })).toBeNull();

  await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Stream stats" }));
  const stats = await within(iphone).findByRole("list", { name: "Stream stats" });
  await waitFor(() => expect(stats.textContent).toMatch(/Received \d+\/s · drawn/));
});

test("enabling devices downloads the device tools, and missing tools offer the download again", async () => {
  const { app, panel } = await openDevices();
  app.daemon.appDevices.toolsReady = false;
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await within(panel).findByRole("list", { name: "Running devices" });
  await waitFor(() => expect(app.daemon.appDevices.toolDownloads).toBe(1));
  await waitFor(() =>
    expect(within(panel).queryByRole("button", { name: "Download device tools" })).toBeNull(),
  );

  // The tools went missing later (deleted from ace's home): the list says so and downloads them.
  act(() => {
    app.daemon.appDevices.toolsReady = false;
    app.daemon.appDevices.addDevice({
      id: "android:Pixel_Tablet_API_35",
      platform: "android",
      name: "Pixel Tablet",
      state: "shutdown",
      runtime: "Android 15",
    });
  });
  const download = await within(panel).findByRole("button", { name: "Download device tools" });
  // The list says it once, not as a problem on top and again as a note below.
  expect(within(panel).getAllByText("The Simulator's device tools aren't downloaded")).toHaveLength(
    1,
  );
  await userEvent.click(download);
  await waitFor(() => expect(app.daemon.appDevices.toolDownloads).toBe(2));
  await waitFor(() =>
    expect(within(panel).queryByRole("button", { name: "Download device tools" })).toBeNull(),
  );
});

import { flakyCheckout } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
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
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: "Devices" }));
  return { app, panel };
}

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
  const iphone = await within(panel).findByRole("region", { name: "iPhone 16 Pro" });

  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));

  expect(await within(iphone).findByText("Agents in this thread can use it")).toBeTruthy();
  expect(app.daemon.appDevices.approval("ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b")).toBe(
    "thread-checkout",
  );
});

test("an emulator boots, streams its screen, and takes keys and text once you take control", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await userEvent.click(await within(panel).findByRole("button", { name: /Pixel 9/ }));
  const pixel = await within(panel).findByRole("region", { name: "Pixel 9" });

  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  await userEvent.click(await within(pixel).findByRole("button", { name: "Start live view" }));

  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await waitFor(() => expect(screenImage.getAttribute("src")).toMatch(/^blob:frame-/));
  expect(within(pixel).getByText(/^Live · You're in control$/)).toBeTruthy();

  await userEvent.click(within(pixel).getByRole("button", { name: "Back" }));
  await userEvent.type(within(pixel).getByRole("textbox", { name: "Type on the device" }), "hello");
  await userEvent.click(within(pixel).getByRole("button", { name: "Send" }));

  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "back" },
      { kind: "type", text: "hello" },
    ]),
  );

  await userEvent.click(within(pixel).getByRole("button", { name: "Release control" }));
  await waitFor(() =>
    expect(within(pixel).getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true),
  );
});

test("without control the live screen only watches: keys stay off", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await within(panel).findByRole("region", { name: "iPhone 16 Pro" });

  await userEvent.click(within(iphone).getByRole("button", { name: "Start live view" }));

  expect(await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" })).toBeTruthy();
  expect(within(iphone).getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(true);
});

test("the device's logs appear while the log section is open", async () => {
  const { panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));

  await userEvent.click(await within(panel).findByRole("button", { name: "Logs" }));

  const logs = await within(panel).findByRole("log", { name: "Device logs" });
  expect(await within(logs).findByText(/SpringBoard launched/)).toBeTruthy();
});

test("revoking approval takes the device away from the thread's agents", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await within(panel).findByRole("region", { name: "iPhone 16 Pro" });
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));

  await userEvent.click(await within(iphone).findByRole("button", { name: "Revoke" }));

  expect(await within(iphone).findByText("Agents in this thread can't use it yet")).toBeTruthy();
  expect(
    app.daemon.appDevices.approval("ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b"),
  ).toBeUndefined();
});

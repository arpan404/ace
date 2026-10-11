import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeviceClientMessage } from "@ace/protocol";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

function noop() {}

let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("none");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

test("the first down and up share control acquisition so the Simulator receives the whole tap", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  await openDevice(panel, "iPhone 16 Pro");
  const create = app.daemon.appDevices.transport.bind(app.daemon.appDevices);
  const claims: (() => void)[] = [];
  let defer = false;
  vi.spyOn(app.daemon.appDevices, "transport").mockImplementation(() => {
    const transport = create();
    let push: (data: unknown) => void = noop;
    let revision = 0;
    return {
      ...transport,
      open(events) {
        push = events.message;
        transport.open(events);
      },
      send(message: DeviceClientMessage) {
        if (message.operation.op !== "controller" || !defer) return transport.send(message);
        const ticket = ++revision;
        claims.push(() => {
          // A second controller claim supersedes the first, just as the device service does.
          if (ticket !== revision)
            push({
              type: "devices.result",
              requestId: message.requestId,
              ok: false,
              error: {
                code: "busy",
                message: "Device control changed",
                hint: "Take control again.",
              },
            });
          else void transport.send(message);
        });
      },
    };
  });
  act(() => app.daemon.appDevices.dropAll());
  await userEvent.click(await within(panel).findByRole("button", { name: "Reconnect" }));
  const device = await within(panel).findByRole("region", { name: "iPhone 16 Pro" });
  await userEvent.click(await within(device).findByRole("button", { name: /Take control/ }));
  const canvas = await within(device).findByRole("img", { name: "iPhone 16 Pro screen" });
  await waitFor(() => expect(browser.draws(canvas)).toBeGreaterThan(0));
  // The page still shows control when both events arrive, but the service clock has expired it.
  const expired = Date.now() + 60000;
  vi.spyOn(Date, "now").mockReturnValue(expired);
  defer = true;
  for (const phase of ["down", "up"]) {
    const event = new MouseEvent(`pointer${phase}`, { bubbles: true, clientX: 10, clientY: 20 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(canvas, event);
  }
  act(() => {
    for (const resume of claims) resume();
  });
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "pointer", phase: "down", x: 10, y: 20 },
      { kind: "pointer", phase: "up", x: 10, y: 20 },
    ]),
  );
  expect(screen.queryByText("Device control changed")).toBeNull();
});

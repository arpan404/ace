import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

const iphoneId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";

let current: ReturnType<typeof deviceBrowser> | undefined;
afterEach(() => current?.restore());

/** The iPhone's tab and live screen, on a daemon whose screen helper can encode H.264. */
async function liveIphone(webCodecs: Parameters<typeof deviceBrowser>[0]) {
  const browser = deviceBrowser(webCodecs);
  current = browser;
  const { app, panel } = await openDevices();
  app.daemon.appDevices.videoEncoding = true;
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await userEvent.click(within(iphone).getByRole("button", { name: "Approve" }));
  const screenImage = await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  return { app, panel, iphone, screenImage, browser };
}

/** The codecs the iPhone's screen asked the daemon for, in order, without repeats. */
function codecs(app: Awaited<ReturnType<typeof openDevices>>["app"]) {
  const asked = app.daemon.appDevices.streamRequests
    .filter((request) => request.deviceId === iphoneId)
    .map((request) => request.settings.codec);
  return asked.filter((codec, index) => codec !== asked[index - 1]);
}

const after = (events: readonly string[], event: string) =>
  events.includes(event) ? events.slice(events.lastIndexOf(event) + 1) : [];

test("without WebCodecs the simulator's screen asks for JPEG and still shows the device", async () => {
  const { app, screenImage, browser } = await liveIphone("none");

  await waitFor(() => expect(browser.draws(screenImage)).toBeGreaterThan(0));
  await waitFor(() => expect(codecs(app)).toEqual(["jpeg"]));
  expect(browser.decoders).toEqual([]);
  expect(new Set(browser.events)).toEqual(new Set(["drew jpeg"]));
  // Each decoded JPEG is released once it is on the canvas.
  expect(browser.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
});

test("with WebCodecs the screen streams H.264, and a failing decoder falls back to JPEG", async () => {
  const { app, screenImage, browser } = await liveIphone("fails");

  await waitFor(() => expect(browser.events).toContain("decoder failed"));
  await waitFor(() => expect(after(browser.events, "decoder failed")).toContain("drew jpeg"));
  expect(codecs(app).slice(-2)).toEqual(["h264", "jpeg"]);
  expect(browser.events).not.toContain("drew h264");
  expect(browser.decoders.every((decoder) => decoder.state === "closed")).toBe(true);
  expect(browser.draws(screenImage)).toBeGreaterThan(0);
});

test("stopping the live view closes the H.264 decoder and every decoded frame", async () => {
  const { iphone, browser } = await liveIphone("decodes");
  await waitFor(() => expect(browser.events).toContain("drew h264"));

  await userEvent.click(within(iphone).getByRole("button", { name: "Device actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Stop live view" }));
  await waitFor(() =>
    expect(within(iphone).queryByRole("img", { name: "iPhone 16 Pro screen" })).toBeNull(),
  );

  expect(browser.decoders.length).toBeGreaterThan(0);
  expect(browser.decoders.map((decoder) => decoder.state)).toEqual(
    browser.decoders.map(() => "closed"),
  );
  expect(browser.videoFrames.length).toBeGreaterThan(0);
  expect(browser.videoFrames.every((frame) => frame.closed)).toBe(true);
});

test("a reconnect closes the old decoder and shows the screen through a fresh one, replaying no input", async () => {
  const { app, panel, iphone, screenImage, browser } = await liveIphone("decodes");
  await waitFor(() => expect(browser.events).toContain("drew h264"));
  await userEvent.click(within(iphone).getByRole("button", { name: /Take control/ }));
  await userEvent.click(await within(iphone).findByRole("button", { name: "Home" }));
  await waitFor(() => expect(app.daemon.appDevices.inputs).toHaveLength(1));
  const before = [...browser.decoders];

  act(() => app.daemon.appDevices.dropAll());
  await waitFor(() => expect(screenImage.isConnected).toBe(false));
  expect(before.every((decoder) => decoder.state === "closed")).toBe(true);

  await userEvent.click(await within(panel).findByRole("button", { name: "Reconnect" }));
  const again = await within(panel).findByRole("img", { name: "iPhone 16 Pro screen" });
  await waitFor(() => expect(browser.draws(again)).toBeGreaterThan(0));
  await waitFor(() => expect(after(browser.events, "decoder opened")).toContain("drew h264"));
  expect(browser.decoders.length).toBeGreaterThan(before.length);
  expect(app.daemon.appDevices.inputs).toHaveLength(1);
});

test("in control, a drag on the simulator's H.264 screen reaches the device as down, moves and up, in order", async () => {
  const { app, iphone, screenImage, browser } = await liveIphone("decodes");
  await waitFor(() => expect(browser.events).toContain("drew h264"));
  await userEvent.click(within(iphone).getByRole("button", { name: /Take control/ }));
  await waitFor(() =>
    expect(within(iphone).getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  const drawn = browser.draws(screenImage);

  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: screenImage, coords: { clientX: 100, clientY: 200 } },
    { target: screenImage, coords: { clientX: 120, clientY: 260 } },
    { target: screenImage, coords: { clientX: 140, clientY: 300 } },
    { keys: "[/MouseLeft]", target: screenImage, coords: { clientX: 140, clientY: 300 } },
  ]);

  const sent = () => app.daemon.appDevices.inputs.map((entry) => entry.input);
  await waitFor(() =>
    expect(sent().at(-1)).toEqual({ kind: "pointer", phase: "up", x: 140, y: 300 }),
  );
  expect(sent()[0]).toEqual({ kind: "pointer", phase: "down", x: 100, y: 200 });
  const moves = sent().slice(1, -1);
  // Motion is coalesced: at least the first move, never one after the release.
  expect(moves[0]).toEqual({ kind: "pointer", phase: "move", x: 120, y: 260 });
  expect(moves.every((input) => input.kind === "pointer" && input.phase === "move")).toBe(true);
  // The device answers with a new frame, decoded and drawn.
  await waitFor(() => expect(browser.draws(screenImage)).toBeGreaterThan(drawn));
  expect(after(browser.events, "decoder opened")).toContain("drew h264");
});

test("a DPR-three device viewer requests every physical pixel and follows monitor density changes", async () => {
  const previous = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { ...original.call(this), width: 350, height: 650 };
  };
  try {
    const { app } = await liveIphone("decodes");
    await waitFor(() =>
      expect(app.daemon.appDevices.streamRequests.at(-1)?.settings).toMatchObject({
        codec: "h264",
        maxWidth: 1088,
        maxHeight: 1984,
        fps: 60,
      }),
    );
    expect(codecs(app)).toEqual(["jpeg", "h264"]);
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() =>
      expect(app.daemon.appDevices.streamRequests.at(-1)?.settings).toMatchObject({
        maxWidth: 704,
        maxHeight: 1344,
      }),
    );
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
    if (previous) Object.defineProperty(window, "devicePixelRatio", previous);
  }
});

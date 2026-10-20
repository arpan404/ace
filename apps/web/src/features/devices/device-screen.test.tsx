import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

const iphoneId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";

let current: ReturnType<typeof deviceBrowser> | undefined;
afterEach(() => current?.restore());

/** The iPhone's tab and live screen; `video: false` is a Mac whose capture can only make JPEG. */
async function liveIphone(webCodecs: Parameters<typeof deviceBrowser>[0], video = true) {
  const browser = deviceBrowser(webCodecs);
  current = browser;
  const { app, panel } = await openDevices();
  app.daemon.appDevices.videoEncoding = video;
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
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

test("without WebCodecs the simulator's screen says this browser can't decode H.264 and draws nothing", async () => {
  const { app, iphone, screenImage, browser } = await liveIphone("none");

  await within(iphone).findByText("This browser can't decode H.264 video");
  expect(codecs(app)).toEqual([]);
  expect(browser.draws(screenImage)).toBe(0);
  expect(browser.events).toEqual([]);
});

test("a decoder the platform refuses says so instead of falling back to JPEG", async () => {
  const { app, iphone, screenImage, browser } = await liveIphone("fails");

  await waitFor(() => expect(browser.events).toContain("decoder failed"));
  await within(iphone).findByText("This browser can't decode H.264 video");
  expect(codecs(app)).toEqual(["h264"]);
  expect(browser.events).not.toContain("drew jpeg");
  expect(browser.decoders.every((decoder) => decoder.state === "closed")).toBe(true);
  expect(browser.draws(screenImage)).toBe(0);
});

test("a device that can't stream video shows the daemon's reason and how to fix it", async () => {
  const { iphone, screenImage, browser } = await liveIphone("decodes", false);

  const alert = await within(iphone).findByRole("alert");
  expect(alert.textContent).toContain(
    "This Mac's screen helper can't stream video for the Simulator live view",
  );
  expect(alert.textContent).toContain("npm install -g serve-sim@0.1.48");
  expect(browser.draws(screenImage)).toBe(0);
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
    expect(codecs(app)).toEqual(["h264"]);
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

test("on an emulator that takes several fingers, an Option-drag pinches with two mirrored fingers", async () => {
  const browser = deviceBrowser("decodes");
  current = browser;
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const pixel = await openDevice(panel, "Pixel 9");
  await userEvent.click(within(pixel).getByRole("button", { name: "Boot" }));
  const screenImage = await within(pixel).findByRole("img", { name: "Pixel 9 screen" });
  await waitFor(() => expect(browser.draws(screenImage)).toBeGreaterThan(0));

  // Option held, as Simulator pinches with a mouse.
  const mouse = { pointerId: 1, pointerType: "mouse", altKey: true };
  fireEvent.pointerDown(screenImage, { ...mouse, clientX: 150, clientY: 300 });
  fireEvent.pointerMove(screenImage, { ...mouse, clientX: 100, clientY: 250 });
  fireEvent.pointerUp(screenImage, { ...mouse, clientX: 100, clientY: 250 });

  const sent = () => app.daemon.appDevices.inputs.map((entry) => entry.input);
  await waitFor(() =>
    expect(sent().slice(-2)).toEqual([
      { kind: "pointer", phase: "up", x: 289, y: 593, pointerId: 1 },
      { kind: "pointer", phase: "up", x: 100, y: 250, pointerId: 0 },
    ]),
  );
  // The second finger mirrors the first through the middle of the 390 × 844 point screen.
  expect(sent().slice(0, 2)).toEqual([
    { kind: "pointer", phase: "down", x: 150, y: 300, pointerId: 0 },
    { kind: "pointer", phase: "down", x: 239, y: 543, pointerId: 1 },
  ]);
  // Motion is coalesced (an unsent move gives way to its finger's lift), never reordered.
  const moves = sent().slice(2, -2);
  expect(moves[0]).toEqual({ kind: "pointer", phase: "move", x: 100, y: 250, pointerId: 0 });
  expect(moves.every((input) => input.kind === "pointer" && input.phase === "move")).toBe(true);
});

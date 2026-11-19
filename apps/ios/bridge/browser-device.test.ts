import { afterEach, describe, expect, test } from "vitest";
import { closeBrowserFixtures, liveBrowser as live, viewport } from "./browser-fixture.ts";
import { phoneDeviceStorage } from "./browser-device.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

afterEach(closeBrowserFixtures);

interface Device {
  toolbar: boolean;
  preset: string | null;
  label: string;
  width: number | null;
  height: number | null;
}
const device = (sink: RecordingSink) =>
  (sink.read("browser:view") as { device?: Device } | undefined)?.device;
const activeTab = (sink: RecordingSink) =>
  (sink.read("browser:view") as { state?: { activeTabId: string | null } | null } | undefined)
    ?.state?.activeTabId;
const commands = (requested: unknown[], action: string) =>
  requested.filter(
    (message) =>
      (message as { type: string }).type === "browser.execute" &&
      (message as { command: { action: string } }).command.action === action,
  ) as { command: Record<string, unknown> }[];
const captures = (requested: unknown[]) =>
  requested.filter((message) => (message as { type: string }).type === "browser.capture") as {
    viewport: { width: number; height: number };
  }[];

/** The phone's store as the app keeps it: loaded once, after `delayMs`, and saved on each change. */
function phoneStore(delayMs = 0, initial = "") {
  let kept = initial;
  return {
    kept: () => kept,
    devices: () =>
      phoneDeviceStorage({
        load: () => new Promise((resolve) => setTimeout(() => resolve(kept), delayMs)),
        save: async (value) => {
          kept = value;
        },
      }),
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("The phone's device toolbar", () => {
  test("a tab without a device opens as this phone: its view's size, as an iPhone", async () => {
    const { daemon, sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => daemon.browser.tab("web")?.emulation !== undefined, "emulated");
    expect(daemon.browser.tab("web")?.emulation).toMatchObject({
      width: 390,
      height: 700,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
      userAgent: expect.stringContaining("iPhone"),
    });
    await until(() => device(sink)?.preset === "this-phone", "shown device");
    expect(device(sink)).toMatchObject({ label: "This phone", width: 390, height: 700 });
    // The view grows (the keyboard closed, a rotation): this phone's page follows it.
    view.action({ kind: "viewport", viewport: { ...viewport, height: 760 } });
    await until(() => daemon.browser.tab("web")?.emulation?.height === 760, "followed the view");
    expect(device(sink)).toMatchObject({ label: "This phone", height: 760 });
  });

  test("a device an agent or another screen chose is kept, never replaced by the phone's", async () => {
    const { daemon, sink, view, requested } = await live();
    const pixel = { width: 412, height: 923, deviceScaleFactor: 2.625, mobile: true, touch: true };
    daemon.browser.tabView("web", undefined, { emulation: { ...pixel, by: "agent" } });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(sink)?.label === "Pixel 9", "agent's device shown");
    // The desktop person picks a laptop while the phone watches: the phone follows it.
    daemon.browser.tabView("web", undefined, {
      emulation: {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
        by: "human",
      },
    });
    await until(() => device(sink)?.label === "Laptop", "other screen's device shown");
    // The phone's view changing size doesn't touch a device it didn't set.
    view.action({ kind: "viewport", viewport: { ...viewport, height: 760 } });
    await pause(50);
    expect(commands(requested, "emulate")).toHaveLength(0);
    expect(daemon.browser.tab("web")?.emulation).toMatchObject({ width: 1280, height: 800 });
  });

  test("picking a device and rotating it sends emulate; the toolbar stays shown for the tab", async () => {
    const store = phoneStore();
    const first = await live({ devices: store.devices() });
    first.view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(first.sink)?.preset === "this-phone", "default device");
    expect(first.view.action({ kind: "device", preset: "pixel-9" })).toBe(true);
    await until(() => device(first.sink)?.label === "Pixel 9", "picked device");
    expect(commands(first.requested, "emulate").at(-1)?.command).toMatchObject({
      action: "emulate",
      width: 412,
      height: 923,
      mobile: true,
      tabId: activeTab(first.sink),
    });
    first.view.action({ kind: "rotate" });
    await until(() => device(first.sink)?.width === 923, "rotated");
    expect(device(first.sink)).toMatchObject({ label: "Pixel 9", height: 412 });
    first.view.action({ kind: "deviceToolbar", show: true });
    await until(() => device(first.sink)?.toolbar === true, "toolbar shown");
    // "This phone" again, by hand.
    first.view.action({ kind: "device", preset: "this-phone" });
    await until(() => device(first.sink)?.preset === "this-phone", "back to this phone");

    // The tab on a daemon that lost its device: the phone gave it one before, so it leaves it.
    const second = await live({ devices: store.devices() });
    second.view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(second.sink)?.toolbar === true, "kept toolbar");
    await pause(50);
    expect(device(second.sink)).toMatchObject({ label: "Responsive", width: null });
    expect(commands(second.requested, "emulate")).toHaveLength(0);
  });

  test("once the desktop removes the phone's device, a reconnect or reopen sends nothing", async () => {
    const { daemon, sink, view, requested } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(sink)?.preset === "this-phone", "this phone");
    // The desktop person closes their device toolbar: the page takes the desktop's pane.
    daemon.browser.tabView("web", undefined, { emulation: undefined });
    await until(() => device(sink)?.label === "Responsive", "device removed");
    daemon.disconnectAll();
    await until(() => sink.read("browser:view")?.generation !== 0, "reconnected");
    view.close();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => activeTab(sink) != null, "reopened");
    await pause(50);
    expect(commands(requested, "emulate")).toHaveLength(1);
    expect(daemon.browser.tab("web")?.emulation).toBeUndefined();
  });

  test("a tab the phone switches to gets this phone too", async () => {
    const { daemon, sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(sink)?.preset === "this-phone", "first tab");
    const opened = daemon.browser.personOpen("web", "https://shop.test/pay");
    view.action({ kind: "tab", tabId: opened });
    await until(() => activeTab(sink) === opened, "tab switch");
    await until(() => daemon.browser.tab("web", opened)?.emulation !== undefined, "emulated");
    expect(daemon.browser.tab("web", opened)?.emulation).toMatchObject({ width: 390 });
  });

  test("the stream is encoded for the picture as drawn, not the bare view", async () => {
    const { sink, view, requested } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => sink.read("browser:view")?.state != null, "subscribed");
    await pause(20);
    // A laptop drawn across the width and zoomed in: 780 × 488 points.
    view.action({ kind: "viewport", viewport, picture: { width: 780, height: 488 } });
    await until(() => captures(requested).length > 0, "capture size");
    expect(captures(requested).at(-1)?.viewport).toMatchObject({
      width: 780,
      height: 488,
      devicePixelRatio: 3,
    });
  });

  test("choices kept on the phone wait for its store, and a slow load never wipes them", async () => {
    const kept = JSON.stringify({
      always: false,
      tabs: [
        ["web/t-other", { toolbar: true, scale: "fit", applied: true }],
        ["bad", 7],
      ],
    });
    const store = phoneStore(30, kept);
    const { sink, view } = await live({ devices: store.devices() });
    view.action({ kind: "open", threadId: "web", viewport });
    view.action({ kind: "deviceToolbar", show: true });
    await until(() => device(sink)?.toolbar === true, "toolbar after load");
    const saved = JSON.parse(store.kept()) as { tabs: [string, unknown][] };
    // The tab kept before is still there; the entry that didn't read is the only one dropped.
    expect(saved.tabs.map(([id]) => id)).toContain("web/t-other");
    expect(saved.tabs).toHaveLength(2);
  });
});

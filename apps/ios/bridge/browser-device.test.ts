import { afterEach, describe, expect, test } from "vitest";
import type { KeyValueStorage } from "@ace/ui-core";
import { closeBrowserFixtures, liveBrowser as live, viewport } from "./browser-fixture.ts";
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
const emulates = (requested: unknown[]) =>
  requested.filter(
    (message) =>
      (message as { type: string }).type === "browser.execute" &&
      (message as { command: { action: string } }).command.action === "emulate",
  ) as { command: Record<string, unknown> }[];

function memory(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("The phone's device toolbar", () => {
  test("a tab without a device opens as the iPhone nearest the phone's width", async () => {
    const { daemon, sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => daemon.browser.tab("web")?.emulation !== undefined, "emulated");
    expect(daemon.browser.tab("web")?.emulation).toMatchObject({
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
      userAgent: expect.stringContaining("iPhone"),
    });
    await until(() => device(sink)?.preset === "iphone-16-pro", "shown device");
    expect(device(sink)).toMatchObject({ label: "iPhone 16 Pro", width: 402, height: 874 });
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
    expect(emulates(requested)).toHaveLength(0);
    expect(daemon.browser.tab("web")?.emulation).toMatchObject({ width: 1280, height: 800 });
  });

  test("picking a device and rotating it sends emulate, and the tab keeps the pick here", async () => {
    const devices = memory();
    const first = await live({ devices });
    first.view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(first.sink)?.preset === "iphone-16-pro", "default device");
    expect(first.view.action({ kind: "device", preset: "pixel-9" })).toBe(true);
    await until(() => device(first.sink)?.label === "Pixel 9", "picked device");
    expect(emulates(first.requested).at(-1)?.command).toMatchObject({
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

    // The same tab on a fresh daemon (its device lost) opens at the phone's pick for it.
    const second = await live({ devices });
    second.view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(second.sink)?.label === "Pixel 9", "kept pick");
    expect(device(second.sink)).toMatchObject({ width: 923, height: 412, toolbar: true });
  });

  test("a tab the phone switches to gets the phone's device too", async () => {
    const { daemon, sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => device(sink)?.preset === "iphone-16-pro", "first tab");
    const opened = daemon.browser.personOpen("web", "https://shop.test/pay");
    view.action({ kind: "tab", tabId: opened });
    await until(() => activeTab(sink) === opened, "tab switch");
    await until(() => daemon.browser.tab("web", opened)?.emulation !== undefined, "emulated");
    expect(daemon.browser.tab("web", opened)?.emulation).toMatchObject({ width: 402 });
  });
});

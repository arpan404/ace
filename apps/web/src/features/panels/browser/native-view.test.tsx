import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { NativeViewPlacement } from "@/boot/desktop-browser.ts";
import { harness } from "@/test/harness.tsx";
import { nativeViewPlacement } from "./native-view.ts";

const screenSize = { width: 1440, height: 900 };
const area = { x: 920, y: 120, width: 520, height: 780 };

describe("where the embedded view goes", () => {
  test("it covers the tab's whole page area", () => {
    expect(nativeViewPlacement({ area, window: screenSize, overlays: [] })).toEqual({
      bounds: area,
      visible: true,
    });
  });

  test("a device-sized page sits centred in the area, inside its margin", () => {
    const { bounds } = nativeViewPlacement({
      area,
      window: screenSize,
      device: { width: 402, height: 874 },
      overlays: [],
    });
    expect(bounds.x).toBeCloseTo(1011.66, 1);
    expect(bounds.y).toBe(144);
    expect(bounds.width / bounds.height).toBeCloseTo(402 / 874);
    expect(bounds.height).toBe(732);
  });

  test("it never reaches past the window's edges while a panel slides in", () => {
    const { bounds, visible } = nativeViewPlacement({
      area: { ...area, x: 1300 },
      window: screenSize,
      overlays: [],
    });
    expect(bounds).toEqual({ x: 1300, y: 120, width: 140, height: 780 });
    expect(visible).toBe(true);
  });

  test("it steps aside while a menu or dialog is drawn over it", () => {
    const menu = { x: 1200, y: 100, width: 200, height: 160 };
    expect(nativeViewPlacement({ area, window: screenSize, overlays: [menu] }).visible).toBe(false);
  });

  test("something drawn elsewhere doesn't hide it", () => {
    const toast = { x: 20, y: 820, width: 300, height: 48 };
    expect(nativeViewPlacement({ area, window: screenSize, overlays: [toast] }).visible).toBe(true);
  });

  test("a collapsed panel shows nothing", () => {
    expect(
      nativeViewPlacement({ area: { ...area, width: 0 }, window: screenSize, overlays: [] })
        .visible,
    ).toBe(false);
  });
});

/** The desktop bridge's `browser.place`, recording what the page asked for. */
let placed: NativeViewPlacement[] = [];
let pageX = 500;
let suggestionVisible = false;
/** The desktop's "the person clicked a page they don't control" event. */
let wantsControl: ((event: { threadId: string }) => void) | undefined;
const box = (x: number, y: number, width: number, height: number) =>
  new DOMRect(x, y, width, height);
const original = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  placed = [];
  pageX = 500;
  suggestionVisible = false;
  Reflect.set(globalThis, "ace", {
    browser: {
      place: async (placement: NativeViewPlacement) => {
        placed.push(placement);
      },
      onWantsControl: (listener: (event: { threadId: string }) => void) => {
        wantsControl = listener;
        return () => {
          if (wantsControl === listener) wantsControl = undefined;
        };
      },
    },
  });
  // jsdom has no layout: the browser's page area sits at the right, and an open menu over it.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-browser-page")) return box(pageX, 100, 400, 600);
    if (suggestionVisible && this.hasAttribute("data-native-overlay"))
      return box(700, 90, 200, 160);
    if (this.getAttribute("role") === "menu") return box(700, 90, 200, 160);
    return box(0, 0, 0, 0);
  };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "ace");
  HTMLElement.prototype.getBoundingClientRect = original;
});

async function openEmbeddedBrowser() {
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).runThrough("turn-2");
  seedPanels(app.daemon);
  // In the desktop app the agent's page runs in the app's own embedded browser.
  app.daemon.browser.drive("thread-cold-start", {
    url: "http://localhost:5173/settings/devices",
    backend: "embedded",
  });
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByText("is using this page", { exact: false }, { timeout: 10000 });
  return { panel, browser: app.daemon.browser };
}

const last = () => placed.at(-1);

test("in the desktop app the browser tab draws the embedded page over its page area", async () => {
  await openEmbeddedBrowser();
  await waitFor(() =>
    expect(last()).toEqual({
      threadId: "thread-cold-start",
      bounds: { x: 500, y: 100, width: 400, height: 600 },
      visible: true,
      dpr: devicePixelRatio,
    }),
  );
});

test("switching to another tool hides the embedded page", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await waitFor(() => expect(last()?.visible).toBe(false));
  expect(last()?.threadId).toBe("thread-cold-start");
});

test("the embedded page steps aside while the tab's menu is open over it", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  await waitFor(() => expect(last()?.visible).toBe(false));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(last()?.visible).toBe(true));
});

test("a page from the daemon's own headless browser is never placed natively", async () => {
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).runThrough("turn-2");
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByText("is using this page", { exact: false }, { timeout: 10000 });
  // The tab has drawn the page's frame, so its layout effects have run.
  await within(panel).findByRole("img", { name: /^Live view of / });
  expect(placed).toEqual([]);
});

test("a click on the agent's page takes control, and the page takes input once it's granted", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  // The agent drives the page: nothing names this client as its holder.
  expect(last()?.owner).toBeUndefined();
  const count = placed.length;
  act(() => wantsControl?.({ threadId: "thread-cold-start" }));
  await within(panel).findByText("have control", { exact: false });
  // The connection the daemon's take-control reply named, which the desktop checks the lease
  // against before any input reaches the page.
  await waitFor(() => expect(last()?.owner).toBe("fake-browser-1"));
  // Taking control changes the placement in place: the page is never hidden meanwhile.
  expect(placed.slice(count).every((placement) => placement.visible)).toBe(true);
});

test("handing control back stops claiming the page", async () => {
  const { panel } = await openEmbeddedBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(last()?.owner).toBe("fake-browser-1"));
  await userEvent.click(within(panel).getAllByRole("button", { name: "Hand back" })[0]!);
  await within(panel).findByText("is using this page", { exact: false }, { timeout: 10000 });
  await waitFor(() => expect(last()?.owner).toBeUndefined());
  expect(last()?.visible).toBe(true);
});

test("while another device holds the page, this one claims nothing and a click takes nothing", async () => {
  const { panel, browser } = await openEmbeddedBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(last()?.owner).toBe("fake-browser-1"));
  // The daemon gives the page to another device's connection (this one's dropped meanwhile).
  await act(async () => {
    browser.disconnect("fake-browser-1");
    await browser.takeover("thread-cold-start", "phone-connection");
  });
  await waitFor(() => expect(last()?.owner).toBeUndefined());
  await within(panel).findByText("Another device has control", { exact: false });
  await waitFor(() => expect(last()?.visible).toBe(true));
  expect(last()?.owner).toBeUndefined();
  act(() => wantsControl?.({ threadId: "thread-cold-start" }));
  await act(async () => Promise.resolve());
  expect(browser.view("thread-cold-start")?.owner).toBe("phone-connection");
  expect(last()?.owner).toBeUndefined();
});

test("a panel move without a resize updates the native page before its next paint", async () => {
  await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.bounds.x).toBe(500));
  pageX = 610;
  await waitFor(() => expect(last()?.bounds.x).toBe(610));
});
test("inline address suggestions hide the native page until they close", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  suggestionVisible = true;
  const input = within(panel).getByRole("combobox", { name: "Address" });
  await userEvent.click(input);
  await userEvent.clear(input);
  await userEvent.type(input, "localhost");
  await within(panel).findByRole("listbox");
  await waitFor(() => expect(last()?.visible).toBe(false));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(last()?.visible).toBe(true));
});

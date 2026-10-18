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
      covered: false,
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

  test("a menu over the page never moves or resizes it; the page is only marked covered", () => {
    const menu = { x: 1200, y: 100, width: 200, height: 160 };
    expect(nativeViewPlacement({ area, window: screenSize, overlays: [menu] })).toEqual({
      bounds: area,
      visible: true,
      covered: true,
    });
  });

  test("something drawn elsewhere doesn't cover it", () => {
    const toast = { x: 20, y: 820, width: 300, height: 48 };
    expect(nativeViewPlacement({ area, window: screenSize, overlays: [toast] }).covered).toBe(
      false,
    );
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
/** Times the page asked the desktop to take the keyboard from the native page. */
let focusRequests = 0;
/** The desktop's picture of the shown native page. */
const picture = "data:image/png;base64,iVBORw0KGgo=";
const box = (x: number, y: number, width: number, height: number) =>
  new DOMRect(x, y, width, height);
const original = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  placed = [];
  pageX = 500;
  suggestionVisible = false;
  focusRequests = 0;
  Reflect.set(globalThis, "ace", {
    browser: {
      focusApp: async () => {
        focusRequests++;
      },
      place: async (placement: NativeViewPlacement) => {
        placed.push(placement);
        return placement.visible;
      },
      snapshot: async () => picture,
    },
  });
  // jsdom has no layout: the browser's page area sits at the right, and an open menu over it.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-browser-page")) return box(pageX, 100, 400, 600);
    if (this.hasAttribute("data-pip-page")) return box(600, 500, 320, 200);
    // The app itself fills the window, beneath anything floating over it.
    if (this.parentElement === document.body && this.querySelector("h1"))
      return box(0, 0, innerWidth, innerHeight);
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
  // The agent's tab is the panel's shown tab, marked with its cursor.
  await within(panel).findByRole("img", { name: /is using this tab$/ }, { timeout: 10000 });
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
    }),
  );
});

test("switching to another tool hides the embedded page", async () => {
  const { panel, browser } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  // With no agent at work, the page doesn't follow the person into picture-in-picture.
  act(() => browser.agentIdle("thread-cold-start"));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await waitFor(() => expect(last()?.visible).toBe(false));
  expect(last()?.threadId).toBe("thread-cold-start");
  expect(last()?.covered).toBeUndefined();
});

const frozen = (panel: HTMLElement) =>
  panel.querySelector<HTMLImageElement>("img[data-frozen-page]");
const pageBox = { x: 500, y: 100, width: 400, height: 600 };

test("a menu over the page never moves it: its picture holds the page's place until the menu closes", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  const before = placed.length;
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  // The picture is drawn exactly where the page is, then the page steps out from under the menu.
  await waitFor(() => expect(frozen(panel)?.getAttribute("src")).toBe(picture));
  expect(frozen(panel)?.style).toMatchObject({ left: "0px", top: "0px", width: "400px" });
  await waitFor(() => expect(last()?.visible).toBe(false));
  // Never moved or resized meanwhile: every placement has the page's own box.
  expect(placed.slice(before).map((placement) => placement.bounds)).toEqual(
    placed.slice(before).map(() => pageBox),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(last()?.visible).toBe(true));
  expect(last()?.bounds).toEqual(pageBox);
  await waitFor(() => expect(frozen(panel)).toBeNull());
  await waitFor(() =>
    expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull(),
  );
});

test("a menu over the page keeps it moving: live frames replace its picture until the menu closes", async () => {
  const { panel, browser } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  await waitFor(() => expect(frozen(panel)).not.toBeNull());
  await waitFor(() => expect(last()?.visible).toBe(false));
  // The page goes on changing under the menu (a video plays): the daemon's frames show it.
  act(() => void browser.navigate("thread-cold-start", "http://localhost:5173/settings/video"));
  const live = await within(panel).findByRole("img", { name: /^Live view of .*settings\/video/ });
  expect(live).toBeTruthy();
  expect(frozen(panel)).toBeNull();
  expect(screen.getByRole("menu")).toBeTruthy();
  // Out of the way, not put away: it keeps rendering and playing sound meanwhile.
  expect(last()).toMatchObject({ bounds: pageBox, visible: false, covered: true });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(last()?.visible).toBe(true));
  expect(last()?.bounds).toEqual(pageBox);
  await waitFor(() =>
    expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull(),
  );
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
  // The tab has drawn the page's frame, so its layout effects have run.
  await within(panel).findByRole("img", { name: /^Live view of / });
  expect(placed).toEqual([]);
});

test("a panel move without a resize updates the native page before its next paint", async () => {
  await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.bounds.x).toBe(500));
  pageX = 610;
  act(() => window.dispatchEvent(new Event("resize")));
  await waitFor(() => expect(last()?.bounds.x).toBe(610));
});
test("a layout that settles after the window's last resize event still moves the native page", async () => {
  await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.bounds.x).toBe(500));
  act(() => window.dispatchEvent(new Event("resize")));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  // The panel clamps to the new width a moment later, with no event of its own.
  pageX = 640;
  await waitFor(() => expect(last()?.bounds.x).toBe(640));
});
test("the native page follows the panel as it slides in and rests where the slide ends", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.bounds.x).toBe(500));
  // The panel's entrance animation moves it with no resize or mutation of its own.
  act(() => panel.dispatchEvent(new Event("animationstart", { bubbles: true })));
  pageX = 520;
  await waitFor(() => expect(last()?.bounds.x).toBe(520));
  pageX = 510;
  await waitFor(() => expect(last()?.bounds.x).toBe(510));
  pageX = 500;
  act(() => panel.dispatchEvent(new Event("animationend", { bubbles: true })));
  await waitFor(() => expect(last()?.bounds.x).toBe(500));
});

test("focusing the address bar takes the keyboard from the native page first", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  const address = within(panel).getByRole("combobox", { name: "Address" });
  act(() => address.blur());
  const before = focusRequests;
  await userEvent.click(address);
  expect(focusRequests).toBe(before + 1);
});

test("inline address suggestions hold the native page in place under the list", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  suggestionVisible = true;
  const input = within(panel).getByRole("combobox", { name: "Address" });
  await userEvent.click(input);
  await userEvent.clear(input);
  await userEvent.type(input, "localhost");
  await within(panel).findByRole("listbox");
  await waitFor(() => expect(frozen(panel)).not.toBeNull());
  await waitFor(() => expect(last()?.visible).toBe(false));
  expect(last()?.bounds).toEqual(pageBox);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(last()?.visible).toBe(true));
});

test("a missing native page keeps the captured page visible", async () => {
  Reflect.set(globalThis, "ace", { browser: { place: async () => false } });
  const { panel } = await openEmbeddedBrowser();
  expect(await within(panel).findByRole("img", { name: /^Live view of / })).toBeTruthy();
});

test("a failed native placement keeps the captured page visible", async () => {
  Reflect.set(globalThis, "ace", {
    browser: {
      place: async () => {
        throw new Error("Native page unavailable");
      },
    },
  });
  const { panel } = await openEmbeddedBrowser();
  expect(await within(panel).findByRole("img", { name: /^Live view of / })).toBeTruthy();
});

test("an old show acknowledgment cannot hide the fallback beneath an open menu", async () => {
  let resolve: ((visible: boolean) => void) | undefined;
  Reflect.set(globalThis, "ace", {
    browser: {
      place: (placement: NativeViewPlacement) => {
        placed.push(placement);
        return placement.visible
          ? new Promise<boolean>((done) => {
              resolve = done;
            })
          : Promise.resolve(false);
      },
    },
  });
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  const originalReceipt = resolve;
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  await waitFor(() => expect(last()?.visible).toBe(false));
  await act(async () => originalReceipt?.(true));
  expect(within(panel).getByRole("img", { name: /^Live view of / })).toBeTruthy();
});

test("visibility notifications cannot hide the fallback before placement acknowledges readiness", async () => {
  let visibility: ((event: { threadId: string; visible: boolean }) => void) | undefined;
  let ready: ((value: boolean) => void) | undefined;
  Reflect.set(globalThis, "ace", {
    browser: {
      place: (placement: NativeViewPlacement) => {
        placed.push(placement);
        return new Promise<boolean>((resolve) => {
          ready = resolve;
        });
      },
      onVisibility: (listener: typeof visibility) => {
        visibility = listener;
        return () => {
          visibility = undefined;
        };
      },
    },
  });
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  act(() => visibility?.({ threadId: "thread-cold-start", visible: true }));
  expect(await within(panel).findByRole("img", { name: /^Live view of / })).toBeTruthy();
  await act(async () => ready?.(true));
  await waitFor(() =>
    expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull(),
  );
});

test("a transient native failure recovers without resizing the panel", async () => {
  let failed = false;
  Reflect.set(globalThis, "ace", {
    browser: {
      place: async (placement: NativeViewPlacement) => {
        placed.push(placement);
        if (placement.visible && !failed) {
          failed = true;
          return false;
        }
        return placement.visible;
      },
    },
  });
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  await waitFor(() =>
    expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull(),
  );
  expect(last()?.bounds).toEqual({ x: 500, y: 100, width: 400, height: 600 });
});

test("an older same-bounds refusal cannot replace a newer acknowledged view", async () => {
  const receipts: ((receipt: string) => void)[] = [];
  Reflect.set(globalThis, "ace", {
    browser: {
      place: (placement: NativeViewPlacement) => {
        placed.push(placement);
        return placement.visible
          ? new Promise<string>((resolve) => receipts.push(resolve))
          : Promise.resolve("hidden");
      },
    },
  });
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(receipts.length).toBe(1));
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  await waitFor(() => expect(last()?.visible).toBe(false));
  expect(last()?.bounds).toEqual(pageBox);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(receipts.length).toBe(2));
  await act(async () => receipts[1]?.("shown"));
  await waitFor(() =>
    expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull(),
  );
  await act(async () => receipts[0]?.("unavailable"));
  expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull();
});

test("closing the other window restores the retained view without taking it over beforehand", async () => {
  let visibility: ((event: { threadId: string; visible: boolean }) => void) | undefined;
  Reflect.set(globalThis, "ace", {
    browser: {
      place: async (placement: NativeViewPlacement) => {
        placed.push(placement);
        return placement.visible ? "superseded" : "hidden";
      },
      onVisibility: (listener: typeof visibility) => {
        visibility = listener;
        return () => {
          visibility = undefined;
        };
      },
    },
  });
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  expect(await within(panel).findByRole("img", { name: /^Live view of / })).toBeTruthy();
  await act(async () => visibility?.({ threadId: "thread-cold-start", visible: true }));
  await waitFor(() =>
    expect(within(panel).queryByRole("img", { name: /^Live view of / })).toBeNull(),
  );
});

test("closing the panel while the agent browses moves the embedded page into picture-in-picture without hiding it", async () => {
  await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  const before = placed.length;
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  await screen.findByRole("region", { name: /^Picture in picture/ });
  await waitFor(() =>
    expect(last()).toMatchObject({
      threadId: "thread-cold-start",
      bounds: { x: 600, y: 500, width: 320, height: 200 },
      visible: true,
      // Laid out at a page's size and scaled down, so it never reflows.
      device: { width: expect.any(Number), height: expect.any(Number) },
    }),
  );
  // The panel let go of the page without hiding it: the floating window took it over.
  await act(async () => {});
  expect(placed.slice(before).some((placement) => !placement.visible)).toBe(false);
  expect(last()?.visible).toBe(true);
});

const latest = (tabId: string) => placed.findLast((placement) => placement.tabId === tabId);

test("split view places each half's own native tab, both on screen at once", async () => {
  const { panel, browser } = await openEmbeddedBrowser();
  const thread = "thread-cold-start";
  const first = browser.view(thread)?.activeTabId ?? "";
  act(() => browser.tabSelect(thread, first));
  const before = within(panel).getAllByRole("tab").length;
  let second = "";
  act(() => {
    second = browser.tabOpen(thread, "https://docs.example/guide", { agentId: "a" });
    browser.pageIdentity(thread, { title: "Guide" }, second);
  });
  await waitFor(() => expect(within(panel).getAllByRole("tab")).toHaveLength(before + 1));
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in split view" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Guide" }));
  await waitFor(() => {
    expect(latest(first)?.visible).toBe(true);
    expect(latest(second)?.visible).toBe(true);
  });
});

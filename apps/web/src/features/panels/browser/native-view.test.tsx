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

  test("it keeps the page visible beside a menu without covering the menu", () => {
    const menu = { x: 1200, y: 100, width: 200, height: 160 };
    const placement = nativeViewPlacement({ area, window: screenSize, overlays: [menu] });
    expect(placement.visible).toBe(true);
    expect(placement.bounds.y).toBeGreaterThanOrEqual(menu.y + menu.height);
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
        return placement.visible;
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
  await within(panel).findByText("is browsing", { exact: false }, { timeout: 10000 });
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
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await waitFor(() => expect(last()?.visible).toBe(false));
  expect(last()?.threadId).toBe("thread-cold-start");
});

test("the embedded page stays visible outside the open menu", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  await waitFor(() => expect(last()?.bounds.y).toBe(250));
  expect(last()?.visible).toBe(true);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(last()?.visible).toBe(true));
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
  await within(panel).findByText("is browsing", { exact: false }, { timeout: 10000 });
  // The tab has drawn the page's frame, so its layout effects have run.
  await within(panel).findByRole("img", { name: /^Live view of / });
  expect(placed).toEqual([]);
});

test("a click on the agent's page asks before taking control", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  // The agent drives the page: nothing names this client as its holder.
  expect(last()?.owner).toBeUndefined();
  const count = placed.length;
  act(() => wantsControl?.({ threadId: "thread-cold-start" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Take over" }).length).toBe(2));
  const question = screen.getAllByRole("button", { name: "Take over" }).at(-1)!;
  expect(last()?.owner).toBeUndefined();
  await userEvent.click(question);
  await within(panel).findByText("You're browsing", { exact: false });
  // The connection the daemon's take-control reply named, which the desktop checks the lease
  // against before any input reaches the page.
  await waitFor(() => expect(last()?.owner).toBe("fake-browser-1"));
  // Taking control changes the placement in place: the page is never hidden meanwhile.
  expect(placed.slice(count).every((placement) => placement.visible)).toBe(true);
});

test("handing control back stops claiming the page", async () => {
  const { panel } = await openEmbeddedBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Take over" }));
  await waitFor(() => expect(last()?.owner).toBe("fake-browser-1"));
  await userEvent.click(within(panel).getAllByRole("button", { name: "Hand back" })[0]!);
  await within(panel).findByText("is browsing", { exact: false }, { timeout: 10000 });
  await waitFor(() => expect(last()?.owner).toBeUndefined());
  expect(last()?.visible).toBe(true);
});

test("while another device holds the page, this one claims nothing and a click takes nothing", async () => {
  const { panel, browser } = await openEmbeddedBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Take over" }));
  await waitFor(() => expect(last()?.owner).toBe("fake-browser-1"));
  // The daemon gives the page to another device's connection (this one's dropped meanwhile).
  await act(async () => {
    browser.disconnect("fake-browser-1");
    await browser.takeover("thread-cold-start", "phone-connection");
  });
  await waitFor(() => expect(last()?.owner).toBeUndefined());
  await within(panel).findByText("Another device has the page", { exact: false });
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
  act(() => window.dispatchEvent(new Event("resize")));
  await waitFor(() => expect(last()?.bounds.x).toBe(610));
});
test("inline address suggestions leave the native page clear of the list", async () => {
  const { panel } = await openEmbeddedBrowser();
  await waitFor(() => expect(last()?.visible).toBe(true));
  suggestionVisible = true;
  const input = within(panel).getByRole("combobox", { name: "Address" });
  await userEvent.click(input);
  await userEvent.clear(input);
  await userEvent.type(input, "localhost");
  await within(panel).findByRole("listbox");
  await waitFor(() => expect(last()?.bounds.y).toBe(250));
  expect(last()?.visible).toBe(true);
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
  await waitFor(() => expect(last()?.bounds.y).toBe(250));
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
  await waitFor(() => expect(last()?.bounds.y).toBe(250));
  expect(last()?.visible).toBe(true);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(receipts.length).toBe(3));
  await act(async () => receipts[2]?.("shown"));
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

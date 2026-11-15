import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { resetDismissed } from "@/features/thread/composer/dismissed-sends.ts";
import { resetSendStore } from "@/features/thread/composer/send-store.ts";
import { resetStops } from "@/features/thread/composer/stop-state.ts";
import {
  layoutAttributes,
  resolveSuitLayout,
  suitLayoutStylesheet,
  suitSidebarWidth,
} from "@/theme/suits/suit-layout.ts";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => {
  resetDismissed();
  resetSendStore();
  resetStops();
});
afterEach(() => {
  for (const name of ["data-theme", "data-suit", "data-scheme", "data-surface", "data-density"])
    document.documentElement.removeAttribute(name);
});

describe("each layout setting reaches the shell as its attribute", () => {
  test.each([
    [{ sidebar: "right" }, "data-layout-sidebar", "right"],
    [{ rail: "hidden" }, "data-layout-rail", "hidden"],
    [{ rail: "merged" }, "data-layout-rail", "merged"],
    [{ composer: "floating" }, "data-layout-composer", "floating"],
    [{ header: "minimal" }, "data-layout-header", "minimal"],
    [{ header: "hidden" }, "data-layout-header", "hidden"],
    [{ messages: "flat" }, "data-layout-messages", "flat"],
    [{ messages: "cards" }, "data-layout-messages", "cards"],
    [{ toolRows: "detailed" }, "data-layout-tool-rows", "detailed"],
    [{ toolRows: "terminal" }, "data-layout-tool-rows", "terminal"],
  ] as const)("%o sets %s", (layout, attribute, value) => {
    expect(layoutAttributes(resolveSuitLayout(layout, { wide: true }))[attribute]).toBe(value);
  });
});

test("without a Suit layout the shell carries no layout attributes and no width rule", () => {
  expect(layoutAttributes(resolveSuitLayout(undefined, { wide: true }))).toEqual({});
  expect(suitLayoutStylesheet({ id: "plain" })).toBe("");
});

test("a narrow window keeps the sheet on the left, docks the composer and shows a hidden header", () => {
  const narrow = resolveSuitLayout(
    { sidebar: "right", composer: "floating", header: "hidden", messages: "cards" },
    { wide: false },
  );
  expect(narrow).toMatchObject({
    sidebar: "left",
    composer: "docked",
    header: "bar",
    messages: "cards",
  });
});

test("the Suit's sidebar width holds until the person drags their own", () => {
  const layout = resolveSuitLayout({ sidebarWidth: 360 }, { wide: true });
  expect(suitSidebarWidth(layout, 288, 288)).toBe(360);
  expect(suitSidebarWidth(layout, 300, 288)).toBe(300);
  expect(suitSidebarWidth(null, 288, 288)).toBe(288);
});

test("the transcript width becomes the Suit's reading column", () => {
  expect(
    suitLayoutStylesheet({
      id: "wide",
      layout: resolveSuitLayout({ transcriptWidth: 900 }, { wide: true }) ?? undefined,
    }),
  ).toBe('[data-suit="wide"]{--column:900px}');
});

async function openWith(layout: Record<string, unknown>) {
  const library = fakeSuitLibrary([fakeSuit({ id: "moved", dark: { canvas: "#101014" }, layout })]);
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify({ suit: "moved" }));
  const app = harness({ storage, suits: library.transport });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-refund-tax");
  const message = await screen.findByRole("combobox", { name: "Message" });
  const threads = await screen.findByRole("navigation", { name: "Projects" });
  await within(threads).findAllByRole("link");
  await waitFor(() => expect(document.documentElement.getAttribute("data-suit")).toBe("moved"));
  return { message, threads };
}

test("with the sidebar on the right, it sits on the right edge and the keyboard still reaches the composer", async () => {
  const { message, threads } = await openWith({ sidebar: "right" });
  const shell = document.querySelector("[data-connection]");
  expect(shell?.getAttribute("data-layout-sidebar")).toBe("right");
  expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-side")).toBe("right");
  // Its resize handle is on its inner (left) edge: the left arrow widens it.
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  const before = Number(handle.getAttribute("aria-valuenow"));
  handle.focus();
  await userEvent.keyboard("{ArrowLeft}");
  await waitFor(() => expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before));

  // F6 walks from the list to the main view to the composer, as on the left.
  within(threads).getAllByRole("link")[0]?.focus();
  await userEvent.keyboard("{F6}");
  expect(document.activeElement).toBe(document.getElementById("main"));
  await userEvent.keyboard("{F6}");
  expect(document.activeElement).toBe(message);
});

test("a merged rail runs as a row inside the sidebar's panel", async () => {
  await openWith({ rail: "merged" });
  const rail = screen.getByRole("navigation", { name: "App" });
  expect(rail.getAttribute("data-variant")).toBe("merged");
  expect(rail.closest('[data-slot="sidebar-panel"]')).not.toBeNull();
});

test("a hidden header shows the screen's title in the sidebar's top row, and keeps its h1", async () => {
  await openWith({ header: "hidden" });
  const heading = await screen.findByRole("heading", { level: 1 });
  const slot = document.querySelector('[data-slot="sidebar-title"]');
  await waitFor(() => expect(slot?.textContent).toBe(heading.textContent));
  expect(heading.className).toContain("sr-only");
});

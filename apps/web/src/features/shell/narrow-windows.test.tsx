import { openProfileView } from "@/test/navigation.ts";
import { coldStartReplay, workbenchServices } from "@ace/fake-daemon";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/** Pretend the window is `width` px wide: media queries answer as a browser would. */
function windowWidth(width: number) {
  // The shell shares the window's width by `innerWidth` (`allocateRoom`), and its frame by media.
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: width });
  const matches = (query: string) =>
    [...query.matchAll(/\((min|max)-width:\s*([\d.]+)rem\)/g)].every(([, bound, rem]) => {
      const px = Number(rem) * 16;
      return bound === "min" ? width >= px : width <= px;
    });
  globalThis.matchMedia = (query: string) =>
    ({
      matches: !query.includes("width") ? false : matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
}
const original = globalThis.matchMedia;
const originalWidth = globalThis.innerWidth;
afterEach(() => {
  globalThis.matchMedia = original;
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: originalWidth });
  vi.restoreAllMocks();
});

/** Pretend the header is laid out `width` px wide (a side panel open beside the column). */
function headerWidth(width: number) {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === "HEADER" ? new DOMRect(0, 0, width, 50) : measure.call(this);
  });
}

/** The side panel's toggle: at the header's right, or ending the docked panel's strip. */
const panelToggle = () => screen.getByRole("button", { name: "Right panel" });

const sidebar = () => screen.queryByRole("complementary", { name: "Threads" });

/** The header's one ⋯, once its code has loaded and it reports itself as a collapsed popup. */
function moreActions(header: HTMLElement) {
  return waitFor(
    () => {
      const button = within(header).getByRole("button", { name: "More actions" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
      return button;
    },
    { timeout: 4_000 },
  );
}

async function openThread() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

test("on a narrow window the sidebar is a sheet from the header, closing once a view is chosen", async () => {
  windowWidth(390);
  await openThread();
  expect(screen.queryByRole("navigation", { name: "App" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  // The same one sidebar: its places, the threads, and the profile with Settings beside it.
  expect(within(sheet).getByRole("navigation", { name: "App" })).toBeTruthy();
  expect(within(sheet).getByRole("complementary", { name: "Threads" })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: /^You, account/ })).toBeTruthy();
  expect(within(sheet).getByRole("link", { name: "Settings" })).toBeTruthy();
  await openProfileView("Automations");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  // On a phone a view opens on its list (ViewListPage); a row opens the item.
  const page = within(screen.getByRole("main"));
  await userEvent.click(await page.findByRole("link", { name: /Nightly dependency audit/ }));
  await screen.findByRole("heading", { level: 2, name: "Nightly dependency audit" });

  // The sheet carries its own toggle and opens the current view's list.
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const again = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(again).getByRole("complementary", { name: "Automations" })).toBeTruthy();
  expect(within(again).queryByRole("complementary", { name: "Threads" })).toBeNull();
  await userEvent.click(within(again).getByRole("button", { name: "Hide sidebar" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
});

test("on a narrow window ⌘\\ opens and closes the sheet and leaves the wide window's choice alone", async () => {
  windowWidth(390);
  const app = await openThread();
  const layout = () => app.storage.getItem("ace.layout");
  const before = layout();

  await userEvent.keyboard("{Meta>}\\{/Meta}");
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(sheet).getByRole("navigation", { name: "App" })).toBeTruthy();
  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  expect(layout()).toBe(before);
});

test("on a phone the header shows the side panel's toggle, and its ⋯ lists Changes", async () => {
  windowWidth(390);
  await openThread();
  const header = screen.getByRole("banner");
  for (const name of ["Back to threads", /^Thread details/, "Right panel"])
    expect(within(header).getByRole("button", { name })).toBeTruthy();
  const more = await moreActions(header);
  await userEvent.click(more);
  expect(await screen.findByRole("menuitem", { name: "Changes" })).toBeTruthy();
  // The toggle is in the header already: the ⋯ doesn't repeat it.
  expect(screen.queryByRole("menuitem", { name: /Summary|Right panel/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Changes" })).toBeNull());
  await userEvent.keyboard("{Meta>}f{/Meta}");
  expect(await screen.findByRole("search", { name: "Search this thread" })).toBeTruthy();
});

test("on a phone the header's panel toggle shows Summary in the chat's place, and Back to chat returns", async () => {
  windowWidth(390);
  await openThread();
  await userEvent.click(panelToggle());
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const work = await within(panel).findByRole("tabpanel", { name: "Summary" });
  expect(await within(work).findByRole("status", { name: /^Thread status/ })).toBeTruthy();
  // In the column's place, not over it: the transcript and its header have stepped aside, and
  // nothing is a dialog or dims the chat.
  expect(panel.getAttribute("data-panel-mode")).toBe("replace");
  expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull();
  expect(screen.queryByRole("banner")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();

  await userEvent.click(within(panel).getByRole("button", { name: "Back to chat" }));
  expect(await screen.findByRole("feed", { name: "Transcript" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("on a phone the thread's Changes open from ⋯ in the chat's place", async () => {
  windowWidth(390);
  await openThread();
  await userEvent.click(await moreActions(screen.getByRole("banner")));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Changes" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: /^Changes/, selected: true })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Thread panel" })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Back to chat" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("in a wide window the header shows only its menu, the thread details icon and the panel toggle", async () => {
  windowWidth(1440);
  await openThread();
  const header = screen.getByRole("banner");
  for (const name of ["More actions", "Right panel", /^Thread details/])
    expect(within(header).getByRole("button", { name })).toBeTruthy();
  for (const name of ["Search this thread", "Turns", "Commit", "Open", "Bottom panel"])
    expect(within(header).queryByRole("button", { name })).toBeNull();
});

test("a header narrowed by a side panel still shows one menu and the details icon", async () => {
  windowWidth(1440);
  headerWidth(400);
  await openThread();
  const header = screen.getByRole("banner");
  expect(within(header).getAllByRole("button", { name: /^Thread details/ })).toHaveLength(1);
  expect(within(header).getAllByRole("button", { name: "More actions" })).toHaveLength(1);
  await userEvent.click(within(header).getByRole("button", { name: "More actions" }));
  expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeTruthy();
});

test("on a phone the panel takes the chat's place with its tabs in the top bar, and Back to chat hands focus to the header's toggle", async () => {
  windowWidth(390);
  await openThread();
  await userEvent.click(panelToggle());
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).queryByRole("separator", { name: /Resize/ })).toBeNull();
  // Focus follows into the panel, onto its showing tab: the header it came from stepped aside.
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-selected")).toBe("true"));
  expect(panel.contains(document.activeElement)).toBe(true);
  // Back to chat leads the strip; full view and the panel's toggle mean nothing here.
  const back = within(panel).getByRole("button", { name: "Back to chat" });
  const tabs = within(panel).getByRole("tablist", { name: "Thread panel tabs" });
  expect(!!(back.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  expect(
    within(panel).queryByRole("button", { name: /Full view|Bottom panel|Right panel/ }),
  ).toBeNull();
  // Not a modal: Escape leaves it where it is.
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "Thread panel" })).toBeTruthy();
  await userEvent.click(back);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(panelToggle()));

  // Its shortcut (Ctrl+Alt+B off Apple) opens it too.
  await userEvent.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
  const opened = await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(opened.contains(document.activeElement)).toBe(true));
  await userEvent.click(within(opened).getByRole("button", { name: "Back to chat" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());

  // ⌘J shows the terminal in the same panel: there is no bottom panel.
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const again = await screen.findByRole("region", { name: "Thread panel" });
  expect(screen.queryByRole("region", { name: "Bottom panel" })).toBeNull();
  await waitFor(() => expect(again.contains(document.activeElement)).toBe(true));
});

test("below 1100px the sidebar steps aside for the right panel and comes back after", async () => {
  windowWidth(1024);
  await openThread();
  expect(sidebar()).toBeTruthy();

  await userEvent.click(panelToggle());
  await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(sidebar()).toBeNull());

  await userEvent.click(panelToggle());
  await waitFor(() => expect(sidebar()).toBeTruthy());
});

test("below 1100px asking for the sidebar back puts the right panel away", async () => {
  windowWidth(1024);
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(sidebar()).toBeNull());

  await userEvent.click(
    within(screen.getByRole("banner")).getByRole("button", { name: "Show sidebar" }),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  expect(sidebar()).toBeTruthy();
});

test("at 1024px the right panel docks beside the thread instead of floating over it", async () => {
  windowWidth(1024);
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "Thread panel" })).toBeTruthy();
});

test("on a tablet the sidebar waits in a sheet, so the thread keeps the window's width", async () => {
  windowWidth(768);
  await openThread();
  // Docked, a 336px sidebar would leave the thread under 500px and fold the composer.
  expect(sidebar()).toBeNull();
  await userEvent.click(
    within(screen.getByRole("banner")).getByRole("button", { name: /sidebar/ }),
  );
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(sheet).getByRole("complementary", { name: "Threads" })).toBeTruthy();
  await userEvent.click(within(sheet).getByRole("button", { name: "Hide sidebar" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  // The panel docks beside the thread and leaves no sidebar behind when it closes.
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const opened = await screen.findByRole("region", { name: "Thread panel" });
  expect(opened.getAttribute("data-panel-mode")).toBe("beside");
  await userEvent.click(within(opened).getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  expect(sidebar()).toBeNull();
});

test("past 896px the sidebar sits beside the thread", async () => {
  windowWidth(960);
  await openThread();
  expect(sidebar()).toBeTruthy();
});

/** The panel's drawn width beside the column. */
const panelWidth = (panel: HTMLElement) => Number.parseFloat(panel.style.width);

/** Resize the window: the shell follows `resize` as a browser's would. */
function resizeWindow(width: number) {
  windowWidth(width);
  act(() => void globalThis.dispatchEvent(new Event("resize")));
}

for (const width of [1024, 800])
  test(`at ${width}px the panel docks beside the thread, its tabs in the top row, with no overlay or scrim`, async () => {
    windowWidth(width);
    await openThread();
    await userEvent.click(panelToggle());
    const panel = await screen.findByRole("region", { name: "Thread panel" });
    expect(panel.getAttribute("data-panel-mode")).toBe("beside");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    // The strip is the panel's own top row, level with the column's header: the tabs and the
    // toggle are there, not in the header, and the transcript stays beside it.
    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("tab")).toBeNull();
    expect(within(panel).getByRole("tablist", { name: "Thread panel tabs" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Right panel" })).toBeTruthy();
    expect(screen.getByRole("feed", { name: "Transcript" })).toBeTruthy();
    expect(within(panel).getByRole("separator", { name: "Resize thread panel" })).toBeTruthy();
    // Not a modal: Escape leaves it open.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "Thread panel" })).toBeTruthy();
  });

test("at 800px the sidebar steps aside first, then the panel narrows so the thread keeps 360px", async () => {
  windowWidth(800);
  await openThread();
  await userEvent.click(panelToggle());
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(sidebar()).toBeNull();
  // Its 520px default would leave the thread 280px: it draws 440px, the thread keeping 360px.
  expect(panelWidth(panel)).toBe(440);
  const handle = within(panel).getByRole("separator", { name: "Resize thread panel" });
  expect(handle.getAttribute("aria-valuemax")).toBe("440");
  expect(handle.getAttribute("aria-valuemin")).toBe("320");
});

test("a dragged panel width comes back once the window has room for it again", async () => {
  windowWidth(1440);
  await openThread();
  await userEvent.click(panelToggle());
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const handle = within(panel).getByRole("separator", { name: "Resize thread panel" });
  handle.focus();
  await userEvent.keyboard("{End}");
  const dragged = panelWidth(panel);
  expect(dragged).toBeGreaterThan(600);

  resizeWindow(800);
  await waitFor(() => expect(panelWidth(panel)).toBe(440));
  resizeWindow(1440);
  await waitFor(() => expect(panelWidth(panel)).toBe(dragged));
});

test("in a wide window the panel sits beside the thread and Escape leaves it open", async () => {
  windowWidth(1440);
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });

  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "Thread panel" })).toBeTruthy();
});

test("the sheet closes when its link to the page already open is tapped", async () => {
  windowWidth(390);
  await openThread();
  // On a phone the header's way to the list is "Back to threads" (#126).
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  const threads = within(sheet).getByRole("navigation", { name: "Threads" });
  await userEvent.click(within(threads).getByRole("link", { name: /^Cap cold-start replay/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
});

test("Search in the sheet opens the threads search in place, and the sheet stays", async () => {
  windowWidth(390);
  await openThread();
  // On a phone the header's way to the list is "Back to threads" (#126).
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  // Row 1 is the title row again: Threads, then Search. Row 2 holds the All projects filter.
  expect(within(sheet).getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  expect(
    within(sheet).getByRole("button", { name: "Project filter: All projects" }).textContent,
  ).toBe("All projects");
  await userEvent.click(within(sheet).getByRole("button", { name: "Search threads" }));
  const field = within(sheet).getByRole("searchbox", { name: "Search threads" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(screen.getByRole("dialog", { name: "Sidebar" })).toBe(sheet);
});

test("on a phone Settings lists its pages once: on the page, with the sheet left to the threads", async () => {
  windowWidth(390);
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  await userEvent.click(within(sheet).getByRole("link", { name: "Settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  const page = within(screen.getByRole("main"));
  expect(await page.findByRole("link", { name: "Appearance" })).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Appearance" })).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const again = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(again).getByRole("complementary", { name: "Threads" })).toBeTruthy();
  expect(within(again).queryByRole("link", { name: "Appearance" })).toBeNull();
});

import { coldStartReplay, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

/** Pretend the window is `width` px wide: media queries answer as a browser would. */
function windowWidth(width: number) {
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
afterEach(() => {
  globalThis.matchMedia = original;
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

test("on a narrow window the rail and sidebar are a sheet from the header, closing once a view is chosen", async () => {
  windowWidth(390);
  await openThread();
  expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(sheet).getByRole("navigation", { name: "Views" })).toBeTruthy();
  expect(within(sheet).getByRole("complementary", { name: "Threads" })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: "Account and connection" })).toBeTruthy();
  await userEvent.click(within(sheet).getByRole("link", { name: /^Automations/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  // On a phone a view opens on its list (ViewListPage); a row opens the item.
  const page = within(screen.getByRole("main"));
  await userEvent.click(await page.findByRole("link", { name: /Nightly dependency audit/ }));
  await screen.findByRole("heading", { level: 2, name: "Nightly dependency audit" });

  // It covers the header's toggle, so it carries its own.
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const again = await screen.findByRole("dialog", { name: "Sidebar" });
  expect(within(again).getByRole("complementary", { name: "Automations" })).toBeTruthy();
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
  expect(within(sheet).getByRole("navigation", { name: "Views" })).toBeTruthy();
  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
  expect(layout()).toBe(before);
});

test("on a phone the header keeps one ⋯ for the actions and the thread menu, and no history", async () => {
  windowWidth(390);
  await openThread();
  const header = screen.getByRole("banner");
  expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
  const overflow = within(header).getAllByRole("button", { name: "More actions" });
  expect(overflow).toHaveLength(1);

  await userEvent.click(await moreActions(header));
  expect(await screen.findByRole("button", { name: "Open" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
  expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeTruthy();
});

test("on a phone the header is a back caret to the list, the title, its status and one ⋯; the tools are in the ⋯", async () => {
  windowWidth(390);
  await openThread();
  const header = screen.getByRole("banner");
  expect(
    within(header)
      .getAllByRole("button")
      .map((button) => button.ariaLabel),
  ).toEqual(["Back to threads", "More actions"]);
  // The agent is still at work on this thread.
  expect(within(header).getByRole("img", { name: "Working" })).toBeTruthy();

  const tools = ["Search this thread", "Turns", "Pin thread summary", "Right panel"];
  for (const name of tools) expect(screen.queryByRole("button", { name })).toBeNull();
  const more = await moreActions(header);
  // Loaded, the tools stay mounted (their shortcuts stay bound) but hidden until it opens.
  for (const name of tools) expect(screen.queryByRole("button", { name })).toBeNull();
  await userEvent.click(more);
  for (const name of tools) expect(await screen.findByRole("button", { name })).toBeTruthy();
  await userEvent.click(more);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Right panel" })).toBeNull());

  // Their shortcuts still work with the ⋯ closed.
  await userEvent.keyboard("{Meta>}f{/Meta}");
  expect(await screen.findByRole("search", { name: "Search this thread" })).toBeTruthy();
});

test("in a wide window the header keeps its tools in view", async () => {
  windowWidth(1440);
  await openThread();
  const header = screen.getByRole("banner");
  for (const name of ["Search this thread", "Pin thread summary", "Right panel"])
    expect(within(header).getByRole("button", { name })).toBeTruthy();
});

test("a header narrowed by a side panel keeps Commit one click away and shows one ⋯", async () => {
  windowWidth(1440);
  headerWidth(560);
  await openThread();
  const header = screen.getByRole("banner");
  expect(within(header).getByRole("button", { name: "Commit" })).toBeTruthy();
  expect(within(header).getByRole("button", { name: "Open" })).toBeTruthy();
  expect(within(header).getAllByRole("button", { name: "More actions" })).toHaveLength(1);
});

test("a header too narrow even for icons folds the actions and the thread menu into one ⋯", async () => {
  windowWidth(1440);
  headerWidth(400);
  await openThread();
  const header = screen.getByRole("banner");
  expect(within(header).queryByRole("button", { name: "Commit" })).toBeNull();
  const overflow = within(header).getAllByRole("button", { name: "More actions" });
  expect(overflow).toHaveLength(1);

  await userEvent.click(await moreActions(header));
  expect(await screen.findByRole("button", { name: "Commit" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
  expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeTruthy();
});

test("on a phone a panel covers the thread as a sheet with its own close", async () => {
  windowWidth(390);
  await openThread();
  // On a phone the panel toggles live in the header's ⋯.
  await userEvent.click(await moreActions(screen.getByRole("banner")));
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).queryByRole("separator", { name: /Resize/ })).toBeNull();
  // The sheet covers the header, so it carries the panel toggle itself.
  await userEvent.click(within(panel).getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("below 1100px the sidebar steps aside for the right panel, the rail stays, and both come back", async () => {
  windowWidth(1024);
  await openThread();
  expect(sidebar()).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(sidebar()).toBeNull());
  // The views stay one click away on the rail.
  expect(
    within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name: "Deck" }),
  ).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: "Right panel" }));
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
  expect(document.querySelector("[data-scrim]")).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "Thread panel" })).toBeTruthy();
});

test("on a small tablet the floating panel leaves the sidebar where the person put it", async () => {
  windowWidth(860);
  await openThread();
  const frame = document.querySelector("[data-sidebar]");
  expect(frame?.getAttribute("data-sidebar")).toBe("shown");
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  expect(document.querySelector("[data-scrim]")).toBeTruthy();
  expect(frame?.getAttribute("data-sidebar")).toBe("shown");
});

test("on a tablet the floating panel closes with Escape, as an overlay does, and focus returns to its toggle", async () => {
  windowWidth(860);
  await openThread();
  const toggle = within(screen.getByRole("banner")).getByRole("button", { name: "Right panel" });
  await userEvent.click(toggle);
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getAllByRole("tab")[0]!);

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  expect(document.activeElement).toBe(toggle);
});

test("on a tablet a click beside the floating panel closes it", async () => {
  windowWidth(860);
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });

  await userEvent.click(document.querySelector<HTMLElement>("[data-scrim]")!);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
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

test("Search in the sheet opens the palette in the sheet's place", async () => {
  windowWidth(390);
  await openThread();
  // On a phone the header's way to the list is "Back to threads" (#126).
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  await userEvent.click(within(sheet).getByRole("button", { name: "Search and commands" }));
  expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull());
});

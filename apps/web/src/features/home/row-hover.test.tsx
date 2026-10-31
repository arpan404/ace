import { workbench } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
const before = (a: string, b: string) => order().indexOf(a) < order().indexOf(b);
const card = (title: RegExp) => within(threads()).getByRole("link", { name: title });

async function openHome(options: Parameters<typeof harness>[0] = {}, path = "/") {
  const app = harness(options);
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open(path);
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

function threadOf(app: ReturnType<typeof harness>, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

test("a row's details open beside it rather than over the rows below", async () => {
  await openHome();
  await userEvent.hover(card(/^Dedupe thread events/));
  const details = await screen.findByLabelText(/^Details for Dedupe thread events/);
  expect(details.closest("[data-side]")?.getAttribute("data-side")).toBe("right");
});

const listViewport = () => {
  const viewport = threads().querySelector("[data-virtual-viewport]");
  if (!(viewport instanceof HTMLElement)) throw new Error("no list");
  return viewport;
};

test("a row's details stay shut while the list scrolls under the pointer", async () => {
  await openHome();
  await userEvent.hover(card(/^Dedupe thread events/));
  fireEvent.wheel(listViewport(), { deltaY: 40 });
  fireEvent.scroll(listViewport());
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(screen.queryByLabelText(/^Details for Dedupe thread events/)).toBeNull();
});

test("an open row's details close as soon as the list scrolls", async () => {
  await openHome();
  await userEvent.hover(card(/^Dedupe thread events/));
  await screen.findByLabelText(/^Details for Dedupe thread events/);
  fireEvent.scroll(listViewport());
  await waitFor(() => expect(screen.queryByLabelText(/^Details for Dedupe thread events/)).toBeNull());
});

/**
 * The workbench seen while its Codex bump was settled moments ago: within the grace period it
 * rests dimmed in ace, offering Unsettle.
 */
const recentlySettled = () => openHome({ uiClock: () => 600_000 });
const settledLabel = (title: string) => card(new RegExp(`^${title}`)).getAttribute("aria-label");

/** Unsettle the dimmed Codex bump back into an ordinary row of ace. */
async function unsettleBump(title: string) {
  await waitFor(() => expect(settledLabel(title)).toMatch(new RegExp(`^${title}\\. Settled`)));
  await userEvent.click(await screen.findByRole("button", { name: `Unsettle ${title}` }));
  await waitFor(() => expect(settledLabel(title)).not.toMatch(/\. Settled/));
}

test("Settle and Unsettle on a recently settled row's hover actions move it out of and back into settled work", async () => {
  const app = await recentlySettled();
  const title = "Bump Codex app-server to 0.48";
  await unsettleBump(title);
  expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeUndefined();

  await userEvent.click(screen.getByRole("button", { name: `Settle ${title}` }));
  // Settled just now, it stays dimmed in ace, offering Unsettle again.
  await waitFor(() => expect(settledLabel(title)).toMatch(new RegExp(`^${title}\\. Settled`)));
  expect(await screen.findByRole("button", { name: `Unsettle ${title}` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Settle ${title}` })).toBeNull();
  await waitFor(() => expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeDefined());
});

/**
 * The row's first line as read, and the controls its box offers beside the row's link (the
 * link's own pull request chip is part of the row, not one of its actions).
 */
const firstLine = (title: RegExp) => card(title).firstElementChild?.firstElementChild?.textContent;
const controls = (title: RegExp) =>
  within(card(title).parentElement ?? document.body)
    .getAllByRole("button")
    .filter((button) => !card(title).contains(button))
    .map((button) => button.getAttribute("aria-label"));

test("hovering an active row shows only snooze, settle and more actions, not the status", async () => {
  await recentlySettled();
  const title = "Bump Codex app-server to 0.48";
  await unsettleBump(title);
  const row = new RegExp(`^${title}`);
  await waitFor(() => expect(card(row)).toBeTruthy());
  const resting = firstLine(row);

  await userEvent.hover(card(row));
  expect(firstLine(row)).not.toBe(resting);
  expect(resting?.startsWith(firstLine(row) ?? "?")).toBe(true);
  expect(controls(row)).toEqual([`Snooze ${title}`, `Settle ${title}`, `Actions for ${title}`]);

  await userEvent.unhover(card(row));
  expect(firstLine(row)).toBe(resting);
});

test("a waiting row's status steps aside for its actions under the pointer or focus", async () => {
  await openHome();
  const row = /^Dedupe thread events after reconnect/;
  expect(firstLine(row)).toContain("Waiting");

  await userEvent.hover(card(row));
  expect(firstLine(row)).not.toContain("Waiting");
  await userEvent.unhover(card(row));
  expect(firstLine(row)).toContain("Waiting");

  card(row).focus();
  await waitFor(() => expect(firstLine(row)).not.toContain("Waiting"));
  card(row).blur();
  await waitFor(() => expect(firstLine(row)).toContain("Waiting"));
});

/** Open on the Dedupe thread, so clicking its row keeps focus on the row. */
const openOnDedupe = () => {
  const id = workbench().find((scenario) => scenario.thread.title.startsWith("Dedupe"))?.thread.id;
  if (!id) throw new Error("Missing scenario");
  return openHome({}, `/t/${id}`);
};

test("a clicked row shows its status again once the pointer moves off it", async () => {
  await openOnDedupe();
  const row = /^Dedupe thread events after reconnect/;
  await userEvent.click(card(row));
  expect(document.activeElement).toBe(card(row));
  expect(firstLine(row)).not.toContain("Waiting");
  await userEvent.unhover(card(row));
  expect(firstLine(row)).toContain("Waiting");
});

test("a clicked row keeps its status when the window gives focus back to it", async () => {
  await openOnDedupe();
  const row = /^Dedupe thread events after reconnect/;
  await userEvent.click(card(row));
  await userEvent.unhover(card(row));
  // Leaving the app blurs the row's link as the window loses focus; coming back refocuses it.
  const away = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await act(async () => card(row).blur());
  away.mockRestore();
  await act(async () => card(row).focus());
  expect(document.activeElement).toBe(card(row));
  expect(firstLine(row)).toContain("Waiting");
});

test("a row shows its status again once its ⋯ menu closes under the pointer", async () => {
  await openHome();
  const row = /^Dedupe thread events after reconnect/;
  await userEvent.hover(card(row));
  await userEvent.click(screen.getByRole("button", { name: /^Actions for Dedupe thread events/ }));
  // The pointer moves off the row onto the menu, which then closes from under it.
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Rename/ }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Rename/ })).toBeNull());
  expect(firstLine(row)).toContain("Waiting");
});

test("work still running offers Snooze on hover but no Settle", async () => {
  await openHome();
  const title = "Dedupe thread events after reconnect";
  expect(screen.getByRole("button", { name: `Snooze ${title}` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Settle ${title}` })).toBeNull();
});

test("the hover clock folds quiet work into Snoozed until the time picked", async () => {
  const app = await openHome();
  const title = "Dedupe thread events after reconnect";
  const id = workbench().find((scenario) => scenario.thread.title === title)?.thread.id;
  if (!id) throw new Error("Missing scenario");
  await userEvent.click(screen.getByRole("button", { name: `Snooze ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  await userEvent.click(await within(threads()).findByRole("button", { name: "Snoozed 1" }));
  expect(card(/^Dedupe.*Snoozed until tomorrow/)).toBeTruthy();
  expect(threadOf(app, id)?.snoozedUntil).toBeDefined();
  expect(before("Backpressure on broadcast fan-out", title)).toBe(true);
});

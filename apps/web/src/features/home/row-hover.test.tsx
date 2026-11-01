import { workbench } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { rowText } from "@/test/row-text.ts";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
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
  await waitFor(() =>
    expect(screen.queryByLabelText(/^Details for Dedupe thread events/)).toBeNull(),
  );
});

/** Open one of the panel's tabs: Inbox, Snoozed or Settled. */
const openTab = (name: "Inbox" | "Snoozed" | "Settled") =>
  userEvent.click(within(threads()).getByRole("tab", { name: new RegExp(`^${name}`) }));
const listed = (title: string) =>
  within(threads()).queryByRole("link", { name: new RegExp(`^${title}`) }) !== null;

/** Unsettle the workbench's settled Codex bump from the Settled tab, back into the Inbox. */
async function unsettleBump(title: string) {
  await openTab("Settled");
  await userEvent.click(await screen.findByRole("button", { name: `Unsettle ${title}` }));
  await waitFor(() => expect(listed(title)).toBe(false));
  await openTab("Inbox");
  await waitFor(() => expect(listed(title)).toBe(true));
}

test("Settle and Unsettle on a settled row's hover actions move it between Settled and the Inbox", async () => {
  const app = await openHome();
  const title = "Bump Codex app-server to 0.48";
  await unsettleBump(title);
  expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeUndefined();

  await userEvent.click(screen.getByRole("button", { name: `Settle ${title}` }));
  await waitFor(() => expect(listed(title)).toBe(false));
  await waitFor(() => expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeDefined());
  // Back in Settled, offering Unsettle again.
  await openTab("Settled");
  expect(await screen.findByRole("button", { name: `Unsettle ${title}` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Settle ${title}` })).toBeNull();
});

/**
 * The status word on an Active row's top line, and the controls its box offers beside the row's
 * link.
 */
const status = (title: RegExp, word: string) =>
  within(card(title)).queryByText(word, { exact: true }) !== null;
const controls = (title: RegExp) =>
  within(card(title).parentElement ?? document.body)
    .getAllByRole("button")
    .filter((button) => !card(title).contains(button))
    .map((button) => button.getAttribute("aria-label"));

test("hovering an Inbox row shows only snooze, settle and more actions, and keeps its three lines", async () => {
  await openHome();
  const title = "Bump Codex app-server to 0.48";
  await unsettleBump(title);
  const row = new RegExp(`^${title}`);
  await waitFor(() => expect(card(row)).toBeTruthy());

  await userEvent.hover(card(row));
  expect(rowText(card(row))).toContain(title);
  expect(rowText(card(row))).toMatch(/^ace/);
  expect(controls(row)).toEqual([`Snooze ${title}`, `Settle ${title}`, `Actions for ${title}`]);
});

test("a waiting row keeps its status beside its actions under the pointer or focus", async () => {
  await openHome();
  const row = /^Dedupe thread events after reconnect/;
  const title = "Dedupe thread events after reconnect";
  expect(status(row, "Waiting")).toBe(true);

  await userEvent.hover(card(row));
  expect(status(row, "Waiting")).toBe(true);
  expect(controls(row)).toContain(`Snooze ${title}`);
  await userEvent.unhover(card(row));
  expect(status(row, "Waiting")).toBe(true);

  card(row).focus();
  await waitFor(() => expect(document.activeElement).toBe(card(row)));
  expect(status(row, "Waiting")).toBe(true);
});

/** Open on the Dedupe thread, so clicking its row keeps focus on the row. */
const openOnDedupe = () => {
  const id = workbench().find((scenario) => scenario.thread.title.startsWith("Dedupe"))?.thread.id;
  if (!id) throw new Error("Missing scenario");
  return openHome({}, `/t/${id}`);
};

test("a clicked row keeps its status, under the pointer and after it moves off", async () => {
  await openOnDedupe();
  const row = /^Dedupe thread events after reconnect/;
  await userEvent.click(card(row));
  expect(document.activeElement).toBe(card(row));
  expect(status(row, "Waiting")).toBe(true);
  await userEvent.unhover(card(row));
  expect(status(row, "Waiting")).toBe(true);
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
  expect(status(row, "Waiting")).toBe(true);
});

test("a row keeps its status once its ⋯ menu closes under the pointer", async () => {
  await openHome();
  const row = /^Dedupe thread events after reconnect/;
  await userEvent.hover(card(row));
  await userEvent.click(screen.getByRole("button", { name: /^Actions for Dedupe thread events/ }));
  // The pointer moves off the row onto the menu, which then closes from under it.
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Rename/ }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Rename/ })).toBeNull());
  expect(status(row, "Waiting")).toBe(true);
});

test("work still running offers Snooze on hover but no Settle", async () => {
  await openHome();
  const title = "Dedupe thread events after reconnect";
  expect(screen.getByRole("button", { name: `Snooze ${title}` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: `Settle ${title}` })).toBeNull();
});

test("the hover clock moves work out of the Inbox into Snoozed until the time picked", async () => {
  const app = await openHome();
  const title = "Dedupe thread events after reconnect";
  const id = workbench().find((scenario) => scenario.thread.title === title)?.thread.id;
  if (!id) throw new Error("Missing scenario");
  await userEvent.click(screen.getByRole("button", { name: `Snooze ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  await waitFor(() => expect(listed(title)).toBe(false));
  expect(listed("Backpressure on broadcast fan-out")).toBe(true);
  await openTab("Snoozed");
  expect(card(/^Dedupe.*Snoozed until tomorrow/)).toBeTruthy();
  expect(within(threads()).getByRole("tab", { name: "Snoozed, 1" })).toBeTruthy();
  expect(threadOf(app, id)?.snoozedUntil).toBeDefined();
});

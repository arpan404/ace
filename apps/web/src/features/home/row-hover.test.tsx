import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

function threadOf(app: ReturnType<typeof harness>, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

test("a row's details open beside it rather than over the rows below", async () => {
  await openHome();
  await userEvent.hover(card(/^Partial refunds/));
  const details = await screen.findByLabelText(/^Details for Partial refunds/);
  expect(details.closest("[data-side]")?.getAttribute("data-side")).toBe("right");
});

test("Settle and Unsettle on a row's hover actions move it between the list and Settled", async () => {
  const app = await openHome();
  const title = "Bump Codex app-server to 0.48";
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(screen.getByRole("button", { name: `Unsettle ${title}` }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeUndefined();
  expect(order()).toContain(title);

  await userEvent.click(screen.getByRole("button", { name: `Settle ${title}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (1)" })).toBeTruthy());
  expect(threadOf(app, "thread-bump-codex")?.settledAt).toBeDefined();
});

/** The row's first line as read, and the controls its box offers. */
const firstLine = (title: RegExp) => card(title).firstElementChild?.firstElementChild?.textContent;
const controls = (title: RegExp) =>
  within(card(title).parentElement ?? document.body)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

test("hovering an active row shows only snooze, settle and more actions, not the status", async () => {
  await openHome();
  const title = "Bump Codex app-server to 0.48";
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(screen.getByRole("button", { name: `Unsettle ${title}` }));
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
  const row = /^Partial refunds double-count tax/;
  expect(firstLine(row)).toContain("Approve");

  await userEvent.hover(card(row));
  expect(firstLine(row)).not.toContain("Approve");
  await userEvent.unhover(card(row));
  expect(firstLine(row)).toContain("Approve");

  card(row).focus();
  await waitFor(() => expect(firstLine(row)).not.toContain("Approve"));
  card(row).blur();
  await waitFor(() => expect(firstLine(row)).toContain("Approve"));
});

test("a clicked row shows its status again once the pointer moves off it", async () => {
  await openHome();
  const row = /^Partial refunds double-count tax/;
  await userEvent.click(card(row));
  expect(document.activeElement).toBe(card(row));
  expect(firstLine(row)).not.toContain("Approve");
  await userEvent.unhover(card(row));
  expect(firstLine(row)).toContain("Approve");
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
  await userEvent.click(await within(threads()).findByRole("button", { name: "Snoozed (1)" }));
  expect(card(/^Dedupe.*Snoozed until tomorrow/)).toBeTruthy();
  expect(threadOf(app, id)?.snoozedUntil).toBeDefined();
  expect(before("Backpressure on broadcast fan-out", title)).toBe(true);
});

import { workbench } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { rowText } from "@/test/row-text.ts";

configure({ asyncUtilTimeout: 10000 });

const title = "Bump Codex app-server to 0.48";
const named = new RegExp(`^${title}`);
const threads = () => screen.getByRole("navigation", { name: "Threads" });
const openTab = (name: "Inbox" | "Settled") =>
  userEvent.click(within(threads()).getByRole("tab", { name: new RegExp(`^${name}`) }));

/** Home on the Settled tab, where the workbench's merged Codex bump rests once settled. */
async function openSettled() {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = harness({ history });
  await app.client.start();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  await openTab("Settled");
  const link = await within(threads()).findByRole("link", { name: named });
  const row = link.parentElement;
  if (!row) throw new Error("No row container");
  return { app, history, link, row };
}

function settledAt(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
}

test("a settled thread is a one-line row in the Settled tab, not in the Inbox", async () => {
  const { link } = await openSettled();
  // One line: the title, then its work (the pull request) at the end. The project and branch
  // are only in its spoken name and hover card.
  expect(rowText(link)).toBe(`${title}#212`);
  const said = link.getAttribute("aria-label") ?? "";
  expect(said).toMatch(new RegExp(`^${title}\\. Done, Codex`));
  expect(said).not.toContain("Settled");
  for (const part of ["chore/codex-048", "Pull request #212"]) expect(said).toContain(part);
  await openTab("Inbox");
  expect(within(threads()).queryByRole("link", { name: named })).toBeNull();
});

test("→ moves from a settled row to Unsettle, which brings the thread back to the Inbox", async () => {
  const { app, link } = await openSettled();
  link.focus();
  // The row's actions sit out of the Tab order (the list is one stop); → reaches them, Snooze
  // first, then Unsettle.
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: `Snooze ${title}` }));
  await userEvent.keyboard("{ArrowRight}");
  const unsettle = screen.getByRole("button", { name: `Unsettle ${title}` });
  expect(document.activeElement).toBe(unsettle);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(within(threads()).queryByRole("link", { name: named })).toBeNull());
  expect(settledAt(app)).toBeUndefined();
  // Back in the Inbox, offering Settle.
  await openTab("Inbox");
  expect(await within(threads()).findByRole("link", { name: named })).toBeTruthy();
  expect(screen.getByRole("button", { name: `Settle ${title}` })).toBeTruthy();
});

test("a settled row's ⋯ opens the row's thread actions", async () => {
  const { row } = await openSettled();
  await userEvent.hover(row);
  await userEvent.click(within(row).getByRole("button", { name: `Actions for ${title}` }));
  const menu = await screen.findByRole("menu");
  for (const name of [/^Rename/, /^Archive/, /^Delete thread/])
    expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Rename/ }));
  expect(await screen.findByRole("textbox", { name: "Thread title" })).toBeTruthy();
});

test("clicking a settled row opens its thread", async () => {
  const { history, link } = await openSettled();
  await userEvent.click(link);
  await waitFor(() => expect(history.location.pathname).toBe("/t/thread-bump-codex"));
});

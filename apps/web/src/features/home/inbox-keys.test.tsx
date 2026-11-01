import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { rowText } from "@/test/row-text.ts";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const row = (title: string) =>
  within(threads()).queryByRole("link", { name: new RegExp(`^${title}`) });
const tab = (name: "Inbox" | "Snoozed" | "Settled") =>
  within(threads()).getByRole("tab", { name: new RegExp(`^${name}`) });
const openTab = (name: "Inbox" | "Snoozed" | "Settled") => userEvent.click(tab(name));
const opened = () => tab("Inbox").getAttribute("aria-selected") === "true";

/** The workbench, plus a finished thread at rest in the Inbox. */
async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  createIdleTask(app.daemon, {
    id: "thread-readme",
    workspaceId: "relay",
    title: "Tidy the README",
    provider: "codex",
  });
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole("link", {
    name: /^Tidy the README/,
  });
  return app;
}
type App = Awaited<ReturnType<typeof openHome>>;
function listed(app: App, id: string) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

/** Keyboard focus on a row's link, as J/K would leave it. */
async function focusRow(title: string) {
  const link = row(title);
  if (!link) throw new Error(`No row for ${title}`);
  link.focus();
  await waitFor(() => expect(document.activeElement).toBe(link));
}

test("E settles the focused finished row into Settled, and the toast's Undo brings it back", async () => {
  const app = await openHome();
  const title = "Tidy the README";
  await focusRow(title);
  await userEvent.keyboard("e");

  await waitFor(() => expect(row(title)).toBeNull());
  await waitFor(() => expect(listed(app, "thread-readme")?.settledAt).toBeDefined());
  // Focus moves on to another row rather than falling out of the list.
  expect(threads().contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.getAttribute("aria-label")).not.toMatch(/^Tidy the README/);
  expect(await screen.findByText(`Settled · ${title}`)).toBeTruthy();
  await openTab("Settled");
  expect(await within(threads()).findByRole("link", { name: /^Tidy the README/ })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(row(title)).toBeNull());
  await waitFor(() => expect(listed(app, "thread-readme")?.settledAt).toBeUndefined());
  await openTab("Inbox");
  expect(await within(threads()).findByRole("link", { name: /^Tidy the README/ })).toBeTruthy();
});

test("H opens a working row's snooze menu; Until it needs you moves it to Snoozed saying so", async () => {
  const app = await openHome();
  const title = "Rewrite the install page for the daemon";
  await focusRow(title);
  await userEvent.keyboard("h");

  const menu = await screen.findByRole("menu");
  // Working, so it can wait for the thread to need the person; with no pull request, no PR wake.
  expect(within(menu).getByRole("menuitem", { name: /^Until it needs you/ })).toBeTruthy();
  expect(within(menu).queryByRole("menuitem", { name: /^Until the PR changes/ })).toBeNull();
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Until it needs you/ }));

  await waitFor(() => expect(row(title)).toBeNull());
  await waitFor(() => expect(listed(app, "thread-install-page")?.snoozedUntil).toBeDefined());
  await openTab("Snoozed");
  const snoozed = await within(threads()).findByRole("link", { name: new RegExp(`^${title}`) });
  expect(rowText(snoozed)).toContain("until it needs you");
  expect(snoozed.getAttribute("aria-label")).toContain("Snoozed until it needs you");
});

test("1, 2 and 3 switch between Inbox, Snoozed and Settled", async () => {
  await openHome();
  await focusRow("Tidy the README");
  await userEvent.keyboard("3");
  await waitFor(() => expect(tab("Settled").getAttribute("aria-selected")).toBe("true"));
  expect(await within(threads()).findByRole("link", { name: /^Bump Codex/ })).toBeTruthy();
  expect(row("Tidy the README")).toBeNull();

  tab("Settled").focus();
  await userEvent.keyboard("2");
  await waitFor(() => expect(tab("Snoozed").getAttribute("aria-selected")).toBe("true"));
  expect(await screen.findByText("Nothing snoozed")).toBeTruthy();

  tab("Snoozed").focus();
  await userEvent.keyboard("1");
  await waitFor(() => expect(opened()).toBe(true));
  expect(await within(threads()).findByRole("link", { name: /^Tidy the README/ })).toBeTruthy();
});

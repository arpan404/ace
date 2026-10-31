import { workbench } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const title = "Bump Codex app-server to 0.48";
const named = new RegExp(`^${title}`);
const settledName = new RegExp(`^${title}\\. Settled`);
const threads = () => screen.getByRole("navigation", { name: "Threads" });

/**
 * Home with the workbench's merged Codex bump settled moments ago: the UI's clock reads just
 * past the daemon's, so the thread is still within its grace period and stays in its project.
 */
async function openSettled() {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = harness({ history, uiClock: () => 600_000 });
  await app.client.start();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  const link = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: settledName },
  );
  const row = link.parentElement;
  if (!row) throw new Error("No row container");
  return { app, history, link, row };
}

function settledAt(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
}

test("in its project a recently settled thread is one dimmed line, its title alone, with no mark", async () => {
  const { link } = await openSettled();
  expect(link.textContent).toBe(title);
  expect(link.querySelector("[data-indicator]")).toBeNull();
  expect(within(link).queryByRole("img", { name: /Codex/ })).toBeNull();
  // Assistive tech hears Settled first, then the context the line leaves out.
  expect(link.getAttribute("aria-label")).toMatch(settledName);
  for (const said of ["Codex", "chore/codex-048", "Pull request #212"])
    expect(link.getAttribute("aria-label")).toContain(said);
});

test("→ moves from a settled row to Unsettle, which brings the thread back to the list", async () => {
  const { app, link } = await openSettled();
  link.focus();
  // The row's actions sit out of the Tab order (the list is one stop); → reaches them.
  await userEvent.keyboard("{ArrowRight}");
  const unsettle = screen.getByRole("button", { name: `Unsettle ${title}` });
  expect(document.activeElement).toBe(unsettle);
  await userEvent.keyboard("{Enter}");
  // Back among its project's open threads, as a full task row offering Settle.
  await waitFor(() => expect(screen.getByRole("button", { name: `Settle ${title}` })).toBeTruthy());
  expect(settledAt(app)).toBeUndefined();
  expect(within(threads()).getByRole("link", { name: named })).toBeTruthy();
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

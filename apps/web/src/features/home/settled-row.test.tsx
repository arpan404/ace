import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const title = "Bump Codex app-server to 0.48";
const named = new RegExp(`^${title}`);
const threads = () => screen.getByRole("navigation", { name: "Threads" });

/** Home with the workbench's merged Codex bump settled and the Settled section open. */
async function openSettled() {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ baseline: 0, project: null, settledOpen: true }),
  );
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = harness({ storage, history });
  await app.client.start();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.client.command({
    type: "thread.settle",
    threadId: ThreadId.parse("thread-bump-codex"),
  });
  await app.open("/");
  const link = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: named },
  );
  const row = link.parentElement;
  if (!row) throw new Error("No row container");
  return { app, history, link, row };
}

function settledAt(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
}

test("a settled thread is one line of project badge and title, without branch, time or provider", async () => {
  const { link, row } = await openSettled();
  // The badge's initials and the title are all the row shows.
  expect(link.textContent).toMatch(new RegExp(`^[A-Za-z]{1,2}${title}$`));
  expect(row.textContent).not.toContain("chore/codex-048");
  expect(row.textContent).not.toMatch(/\bago\b|\b\d+[smhd]\b/);
  expect(within(link).queryByRole("img")).toBeNull();
  // Assistive tech still hears the context the line leaves out.
  expect(link.getAttribute("aria-label")).toContain("Codex");
});

test("focus moves from a settled row to Unsettle, which brings the thread back to the list", async () => {
  const { app, link } = await openSettled();
  link.focus();
  await userEvent.tab();
  const unsettle = screen.getByRole("button", { name: `Unsettle ${title}` });
  expect(document.activeElement).toBe(unsettle);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
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

import { openProfileView } from "@/test/navigation.ts";
import { facts, failingSubagent, longHistory } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const title = (name: string) => screen.findByRole("heading", { level: 1, name });
const threadList = () => screen.queryByRole("complementary", { name: "Threads" });
/** A button at the left of the window's top bar, where back, forward and the sidebar toggle sit. */
const inTopBar = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

test("every view and settings page opens in the shell under its own title", async () => {
  const pages: [string, string][] = [
    ["/", "Home"],
    ["/new", "New thread"],
    ["/automations", "Automations"],
    ["/skills", "Skills"],
    ["/usage", "Usage"],
    ["/archived", "Archived"],
    ["/settings", "Settings"],
  ];
  for (const [path, name] of pages) {
    const view = await harness().open(path);
    await title(name);
    expect(screen.getByRole("navigation", { name: "App" })).toBeTruthy();
    view.unmount();
  }
  await harness().open("/settings");
  await screen.findByRole("heading", { level: 2, name: "General" });
  const pagesNav = screen.getByRole("navigation", { name: "Settings pages" });
  for (const page of ["General", "Appearance", "Providers", "Fleet", "Keyboard", "Advanced"]) {
    await userEvent.click(within(pagesNav).getByRole("link", { name: page }));
    await screen.findByRole("heading", { level: 2, name: page });
  }
});

test("removed pages are gone: their addresses show Not found and the palette never offers them", async () => {
  for (const path of [
    "/deck",
    "/offsets/new",
    "/more",
    "/more/search",
    "/pull-requests",
    "/accounts",
    "/activity",
  ]) {
    const view = await harness().open(path);
    await title("This page doesn't exist");
    view.unmount();
  }
  await harness().open("/");
  await title("Home");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(search, "Usage");
  expect(await screen.findByRole("option", { name: /^Usage\s*Go to/ })).toBeTruthy();
  // Pull requests and Issues are pages again, at /pulls and /issues.
  for (const page of ["Pull requests", "Issues"]) {
    await userEvent.clear(search);
    await userEvent.type(search, page);
    expect(await screen.findByRole("option", { name: new RegExp(`^${page}`) })).toBeTruthy();
  }
  for (const removed of ["Deck", "Activity"]) {
    await userEvent.clear(search);
    await userEvent.type(search, removed);
    // The palette has answered once it offers to search the threads for the words.
    await screen.findByRole("option", { name: new RegExp(`^Search all threads for “${removed}”`) });
    expect(screen.queryByRole("option", { name: new RegExp(`^${removed}`) })).toBeNull();
  }
});

test("back and forward in the header follow profile view history", async () => {
  await harness().open("/");
  await title("Home");
  expect(inTopBar("Back").disabled).toBe(true);
  expect(inTopBar("Forward").disabled).toBe(true);

  await openProfileView("Automations");
  await title("Automations");
  expect(
    within(screen.getByRole("navigation", { name: "App" }))
      .getByRole("link", { name: "Automations" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(inTopBar("Back").disabled).toBe(false);

  await userEvent.click(inTopBar("Back"));
  await title("Home");
  expect(inTopBar("Back").disabled).toBe(true);
  expect(inTopBar("Forward").disabled).toBe(false);

  await userEvent.keyboard("{Meta>}]{/Meta}");
  await title("Automations");
  expect(inTopBar("Forward").disabled).toBe(true);
});

test("⌘\\ hides the sidebar and the header offers to bring it back", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/");
  await screen.findByRole("complementary", { name: "Threads" });
  expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();

  await userEvent.keyboard("{Meta>}\\{/Meta}");
  await waitFor(() => expect(threadList()).toBeNull());
  await userEvent.click(
    within(screen.getByRole("banner")).getByRole("button", { name: "Show sidebar" }),
  );
  expect(threadList()).toBeTruthy();
});

test("view shortcuts need a modifier, so they work while typing and plain letters just type", async () => {
  await harness().open("/automations");
  await title("Automations");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(search, "gh");
  expect((search as HTMLInputElement).value).toBe("gh");
  expect(screen.queryByRole("heading", { level: 1, name: "Home" })).toBeNull();

  // jsdom is not an Apple platform: Ctrl+Alt+H there (⌃⌘H on a Mac).
  await userEvent.keyboard("{Control>}{Alt>}h{/Alt}{/Control}");
  // The open palette hides the page; once it closes, Home is showing.
  await userEvent.keyboard("{Escape}");
  await title("Home");
});

test("⌘K finds a thread by title and opens it", async () => {
  const app = harness();
  app.play(failingSubagent()).step();
  await app.open("/");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  await userEvent.type(within(dialog).getByRole("combobox"), "Migrate settings");
  await userEvent.keyboard("{Enter}");
  await title("Migrate settings schema");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
});

test("the top bar keeps the current project beside the thread title when the sidebar is hidden", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "thread-top-bar",
    workspaceId: "relay",
    provider: "claude",
    title: "Replay cursor resets on every resume",
  });
  app.daemon.apply("thread-top-bar", [facts.rootAgent("claude")]);
  await app.open("/t/thread-top-bar");
  await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
  const bar = screen.getByRole("banner");
  expect(within(bar).getByRole("heading", { level: 1 })).toBeTruthy();
  expect(within(bar).getByRole("img", { name: /^Project / })).toBeTruthy();
  expect(await within(bar).findByText("relay")).toBeTruthy();
  // While the sidebar shows, navigation leads the sidebar's top row, so nothing comes before
  // the title in the column's part of the bar.
  expect(within(bar).queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(within(bar).getByText("relay")).toBeTruthy();
  expect(
    within(bar).getByRole("heading", { name: "Replay cursor resets on every resume" }),
  ).toBeTruthy();
});

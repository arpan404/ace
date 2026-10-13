import { flakyCheckout, workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

async function openApp(path = "/") {
  const app = harness();
  for (const scenario of [...workbench(), flakyCheckout()]) app.play(scenario).runUntilBlocked();
  await app.open(path);
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

/** The sidebar's thread rows, top to bottom. */
const rows = () =>
  within(screen.getByRole("list", { name: "Threads" })).getAllByRole("link", { hidden: true });
const titleOf = (row: HTMLElement) => row.getAttribute("aria-label")?.split(/[.,]/)[0] ?? "";
const heading = () => screen.findByRole("heading", { level: 1 });

test("⌥⌘↓ and ⌥⌘↑ move to the next and previous thread in the sidebar's order", async () => {
  await openApp();
  const [first, second] = rows();
  if (!first || !second) throw new Error("The list needs two threads");
  await userEvent.click(first);
  await waitFor(async () => expect((await heading()).textContent).toBe(titleOf(first)));
  await userEvent.keyboard("{Alt>}{Meta>}{ArrowDown}{/Meta}{/Alt}");
  await waitFor(async () => expect((await heading()).textContent).toBe(titleOf(second)));
  await userEvent.keyboard("{Alt>}{Meta>}{ArrowUp}{/Meta}{/Alt}");
  await waitFor(async () => expect((await heading()).textContent).toBe(titleOf(first)));
});

test("⌥⌘J moves to the next thread that needs you", async () => {
  await openApp("/t/thread-dedupe");
  await screen.findByRole("heading", { level: 1, name: "Dedupe thread events after reconnect" });
  expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  await userEvent.keyboard("{Alt>}{Meta>}j{/Meta}{/Alt}");
  expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeTruthy();
  expect((await heading()).textContent).not.toBe("Dedupe thread events after reconnect");
});

test("the thread list is one Tab stop, and ↑ ↓ move between its rows", async () => {
  await openApp();
  const list = screen.getByRole("list", { name: "Threads" });
  screen.getByRole("link", { name: "New thread" }).focus();
  // Tab on through the sidebar's controls above the list until it lands in the list.
  for (let press = 0; press < 4 && !list.contains(document.activeElement); press++)
    await userEvent.tab();
  const entered = document.activeElement;
  expect(rows()).toContain(entered);
  // One stop: the next Tab leaves the list rather than visiting each row and its actions.
  await userEvent.tab();
  expect(list.contains(document.activeElement)).toBe(false);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(entered);
  await userEvent.keyboard("{ArrowDown}");
  const moved = document.activeElement;
  expect(moved).not.toBe(entered);
  expect(rows()).toContain(moved);
  // The row arrows reached is the list's Tab stop now.
  expect(rows().filter((row) => row.tabIndex === 0)).toEqual([moved]);
  // Its actions are reached with →, and ← comes back to the row.
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Snooze /);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(moved);
});

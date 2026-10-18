import { flakyCheckout, workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { jumpHintDelayMs } from "./list-jump-keys.tsx";

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
  within(screen.getByRole("list", { name: "Threads" }))
    .getAllByRole("link", { hidden: true })
    .filter((link) => link.hasAttribute("data-row-focus") && !link.closest("[inert]"));
const titleOf = (row: Element) => row.getAttribute("aria-label")?.split(/[.,]/)[0] ?? "";
const focusedTitle = () => (document.activeElement ? titleOf(document.activeElement) : "");
const heading = () => screen.findByRole("heading", { level: 1 });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Home and End move to the first and last row of the list", async () => {
  await openApp();
  const all = rows();
  const first = all[0];
  // The list ends on the folded Settled section's toggle, the last row ↓ reaches.
  const settled = screen.getByRole("button", { name: /^Settled \(\d+\)/ });
  if (!first || all.length < 2) throw new Error("The list needs two threads");
  all[1]?.focus();
  await userEvent.keyboard("{End}");
  await waitFor(() => expect(document.activeElement).toBe(settled));
  await userEvent.keyboard("{Home}");
  await waitFor(() => expect(document.activeElement).toBe(first));
});

const letterOf = (row: Element) => titleOf(row)[0]?.toLowerCase() ?? "";
const hints = () =>
  [...document.querySelectorAll("[data-jump-hint]")].map((hint) => hint.textContent);

test("typing a letter on a row jumps to the next thread whose title starts with it", async () => {
  await openApp();
  const all = rows();
  const first = all[0];
  // The first row below whose letter no row between has, and isn't one of the list's own keys.
  const target = all
    .slice(1)
    .find(
      (row, index) =>
        /^[a-z]$/.test(letterOf(row)) &&
        !"gjkpx".includes(letterOf(row)) &&
        all.slice(1, index + 1).every((before) => letterOf(before) !== letterOf(row)),
    );
  if (!first || !target) throw new Error("The list needs a row to jump to");
  first.focus();
  await userEvent.keyboard(letterOf(target));
  await waitFor(() => expect(focusedTitle()).toBe(titleOf(target)));
});

test("when the focused row is settled, focus moves to the next row rather than the page", async () => {
  await openApp();
  const settle = within(screen.getByRole("list", { name: "Threads" })).getAllByRole("button", {
    name: /^Settle /,
    hidden: true,
  })[0];
  if (!settle) throw new Error("A row must offer Settle");
  const title = settle.getAttribute("aria-label")?.replace(/^Settle /, "") ?? "";
  const all = rows();
  const at = all.findIndex((row) => titleOf(row) === title);
  const next = all[at + 1] ?? all[at - 1];
  if (at < 0 || !next) throw new Error("The settled row needs a neighbour");
  all[at]?.focus();
  // → walks into the row's actions until it reaches Settle.
  for (let press = 0; press < 4 && document.activeElement !== settle; press++)
    await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(settle);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(focusedTitle()).toBe(titleOf(next)));
  expect(document.activeElement).not.toBe(document.body);
});

test("⌥⌘2 in a browser tab opens the second thread in the list", async () => {
  await openApp();
  const second = rows()[1];
  if (!second) throw new Error("The list needs two threads");
  await userEvent.keyboard("{Alt>}{Meta>}2{/Meta}{/Alt}");
  await waitFor(async () => expect((await heading()).textContent).toBe(titleOf(second)));
});

test("holding the jump modifiers shows the first rows' numbers until they are let go", async () => {
  await openApp();
  const user = userEvent.setup();
  await user.keyboard("{Alt>}{Meta>}");
  await wait(jumpHintDelayMs + 100);
  await waitFor(() => expect(hints().slice(0, 3)).toEqual(["1", "2", "3"]));
  expect(hints().length).toBeLessThanOrEqual(9);
  await user.keyboard("{/Meta}{/Alt}");
  await waitFor(() => expect(hints()).toEqual([]));
});

test("Search narrows the list as you type; ↓ enters it, Esc clears it and Enter opens a match", async () => {
  await openApp();
  const search = screen.getByRole("searchbox", { name: "Search threads" });
  const all = rows();
  const wanted = titleOf(all[1] ?? all[0] ?? document.body);
  const word = wanted.split(" ").find((part) => part.length > 4) ?? wanted;
  await userEvent.click(search);
  await userEvent.keyboard(word);
  await waitFor(() => {
    const shown = rows().map(titleOf);
    expect(shown).toContain(wanted);
    expect(shown.length).toBeLessThan(all.length);
    for (const title of shown) expect(title.toLowerCase()).toContain(word.toLowerCase());
  });
  await userEvent.keyboard("{ArrowDown}");
  expect(rows()).toContain(document.activeElement);

  search.focus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(rows()).toHaveLength(all.length));
  expect(search).toHaveProperty("value", "");

  await userEvent.click(search);
  await userEvent.keyboard(`${word}{Enter}`);
  await waitFor(async () =>
    expect((await heading()).textContent?.toLowerCase()).toContain(word.toLowerCase()),
  );
});

test("a search that matches nothing says so in one line", async () => {
  await openApp();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search threads" }), "zzqqxxnothing");
  expect(await screen.findByText("No matching threads")).toBeTruthy();
});

test("⌥⌘F puts the caret in the list's Search from anywhere", async () => {
  await openApp("/t/thread-dedupe");
  await heading();
  await userEvent.keyboard("{Alt>}{Meta>}f{/Meta}{/Alt}");
  expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search threads" }));
});

import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { openExplorer } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const pressed = (button: HTMLElement) => button.getAttribute("aria-pressed");

test("the explorer's header switches between Files and Search with two icons, the one showing pressed", async () => {
  const { panel } = await openExplorer();
  const header = within(await within(panel).findByRole("group", { name: "Explorer" }));
  const files = header.getByRole("button", { name: "Files" });
  const search = header.getByRole("button", { name: "Search" });
  // Icons alone: the words are the buttons' names and tooltips, not text on them.
  expect(files.textContent).toBe("");
  expect(search.textContent).toBe("");
  expect([pressed(files), pressed(search)]).toEqual(["true", "false"]);
  // The tree's actions sit in the same row while Files shows.
  expect(within(panel).getByRole("button", { name: "New file" })).toBeTruthy();

  await userEvent.click(search);
  expect(
    await within(panel).findByRole("searchbox", { name: "Search file contents" }),
  ).toBeTruthy();
  expect([pressed(files), pressed(search)]).toEqual(["false", "true"]);
  expect(within(panel).queryByRole("button", { name: "New file" })).toBeNull();

  await userEvent.click(files);
  expect(await within(panel).findByRole("tree", { name: "Checkout files" })).toBeTruthy();
  expect(screen.queryByRole("searchbox", { name: "Search file contents" })).toBeNull();
});

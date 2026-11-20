import { act, configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { openSearch, thread } from "./content-search-test-support.ts";
import { bytes } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const results = (panel: HTMLElement) =>
  within(panel).findByRole("list", { name: "Search results" });
const hit = async (panel: HTMLElement, name: string) =>
  within(await results(panel)).findByRole("button", { name });

test("a picked hit keeps the list and its folds; F4 and ⇧F4 open the next and previous hit", async () => {
  const { panel, field } = await openSearch();
  await userEvent.type(field, "quokka");
  expect(await within(panel).findByText("3 results in 2 files")).toBeTruthy();
  await userEvent.click(await hit(panel, "src/other.ts, 1 result"));

  await userEvent.click(await hit(panel, "src/cache.ts line 2: const hit = quokka.get(key);"));
  await within(panel).findByRole("region", { name: "Source of src/cache.ts" });
  expect(await within(panel).findByText("Line 2, column 13")).toBeTruthy();
  // The list stays as the person left it: other.ts still folded, the picked hit marked.
  expect((await hit(panel, "src/other.ts, 1 result")).getAttribute("aria-expanded")).toBe("false");
  const second = await hit(panel, "src/cache.ts line 2: const hit = quokka.get(key);");
  expect(second.getAttribute("aria-current")).toBe("true");

  await userEvent.keyboard("{F4}");
  expect(await within(panel).findByText("Line 3, column 3")).toBeTruthy();
  const third = await hit(panel, "src/cache.ts line 3: quokka.set(key, hit);");
  await waitFor(() => expect(third.getAttribute("aria-current")).toBe("true"));
  // Stepping goes through folded files too, then wraps back round.
  await userEvent.keyboard("{F4}");
  await within(panel).findByRole("region", { name: "Source of src/other.ts" });
  expect(await within(panel).findByText("Line 1, column 14")).toBeTruthy();
  await userEvent.keyboard("{Shift>}{F4}{/Shift}");
  await within(panel).findByRole("region", { name: "Source of src/cache.ts" });
  expect(await within(panel).findByText("Line 3, column 3")).toBeTruthy();
});

test("results refresh once the daemon says a matched file's folder changed after a save", async () => {
  const { app, panel, field, folders } = await openSearch();
  await userEvent.type(field, "quokka");
  expect(await within(panel).findByText("3 results in 2 files")).toBeTruthy();
  // The folders of the files found are watched, so the daemon reports writes to them.
  await waitFor(() => expect(folders.watches.at(-1)).toContain("src"));

  await userEvent.click(await hit(panel, "src/cache.ts line 2: const hit = quokka.get(key);"));
  // Always editable: no mode to enter first.
  const editor = await within(panel).findByRole("region", { name: "Source of src/cache.ts" });
  const box = await within(editor).findByRole("textbox");
  await userEvent.click(box);
  await userEvent.keyboard("{Control>}{End}{/Control}quokka.clear();{Control>}s{/Control}");
  await waitFor(async () => expect(await bytes(app, "src/cache.ts")).toContain("quokka.clear();"));

  act(() => folders.changed(["src"]));
  expect(await within(panel).findByText("4 results in 2 files")).toBeTruthy();
  expect(await hit(panel, "src/cache.ts line 4: quokka.clear();")).toBeTruthy();
  // The refresh kept the list in place: it never emptied to "Searching…".
  expect(within(panel).queryByText("Searching…")).toBeNull();
  expect(thread).toBe("thread-cold-start");
});

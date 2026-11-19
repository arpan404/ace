import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";

/** The thread's Files tab, its checkout seeded with a few files to search, on its Search side. */
async function openSearch(options: { hold?: string } = {}) {
  const app = harness();
  folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  app.daemon.checkouts.seed(
    thread,
    "src/cache.ts",
    "const a = 1;\nconst hit = quokka.get(key);\n  quokka.set(key, hit);\n",
  );
  app.daemon.checkouts.seed(thread, "src/other.ts", "export const Quokka = new Map();\n");
  app.daemon.checkouts.seed(thread, "docs/notes.md", "Wombat notes.\n");
  // What the app asks the daemon for, and which of those asks it later gave up on.
  const searches: { pattern: string; signal: AbortSignal | undefined }[] = [];
  const request = app.client.request.bind(app.client);
  app.client.request = ((input, settings) => {
    if (input.type === "files.request" && input.operation.op === "search") {
      const signal = settings?.signal;
      searches.push({ pattern: input.operation.pattern, signal });
      // A held search stays with the daemon until the app calls it off.
      if (input.operation.pattern === options.hold && signal)
        return new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        );
    }
    return request(input, settings);
  }) as typeof app.client.request;
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Files/ }));
  const tree = await within(panel).findByRole("tree", { name: "Checkout files" });
  await within(tree).findByRole("treeitem", { name: "README.md" });
  // ⌘⇧F from inside the Files tab focuses the Search field.
  within(tree).getByRole("treeitem", { name: "README.md" }).focus();
  await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  const field = await within(panel).findByRole("searchbox", { name: "Search file contents" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  return { app, panel, field, searches };
}

test("typing a query shows the matches grouped by file, with counts and a summary line", async () => {
  const { panel, field } = await openSearch();
  await userEvent.type(field, "quokka");
  const results = await within(panel).findByRole("list", { name: "Search results" });
  expect(await within(panel).findByText("3 results in 2 files")).toBeTruthy();
  expect(within(results).getByRole("button", { name: "src/cache.ts, 2 results" })).toBeTruthy();
  expect(within(results).getByRole("button", { name: "src/other.ts, 1 result" })).toBeTruthy();
  const line = within(results).getByRole("button", {
    name: "src/cache.ts line 2: const hit = quokka.get(key);",
  });
  expect(within(line).getByText("quokka", { selector: "mark" })).toBeTruthy();
  expect(within(results).queryByText(/notes\.md/)).toBeNull();

  // Folding a file hides its lines; the count stays.
  await userEvent.click(within(results).getByRole("button", { name: "src/cache.ts, 2 results" }));
  expect(within(results).queryByRole("button", { name: /^src\/cache\.ts line/ })).toBeNull();
});

test("the toggles narrow the search: case and whole word", async () => {
  const { panel, field } = await openSearch();
  await userEvent.type(field, "Quokka");
  expect(await within(panel).findByText("3 results in 2 files")).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Match case" }));
  expect(await within(panel).findByText("1 result in 1 file")).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Match case" }));
  await userEvent.clear(field);
  await userEvent.type(field, "quok");
  expect(await within(panel).findByText("3 results in 2 files")).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Match whole word" }));
  expect(await within(panel).findByText("No results.")).toBeTruthy();
});

test("clicking a match opens its file at the match's line and column", async () => {
  const { panel, field } = await openSearch();
  await userEvent.type(field, "quokka.set");
  const results = await within(panel).findByRole("list", { name: "Search results" });
  await userEvent.click(
    await within(results).findByRole("button", {
      name: "src/cache.ts line 3: quokka.set(key, hit);",
    }),
  );
  await within(panel).findByRole("region", { name: "Source of src/cache.ts" });
  // The editor announces where the jump landed: line 3, two spaces in.
  expect(await within(panel).findByText("Line 3, column 3")).toBeTruthy();
  // The Search side stays with its results beside the opened file.
  expect(within(panel).getByRole("list", { name: "Search results" })).toBeTruthy();
});

test("a newer query cancels the old search and replaces its results", async () => {
  const { panel, field, searches } = await openSearch({ hold: "Wombat" });
  await userEvent.type(field, "Wombat");
  expect(await within(panel).findByText("Searching…")).toBeTruthy();
  await waitFor(() => expect(searches).toHaveLength(1));
  // Typed over, never emptied: the newer query is what calls the old search off.
  await userEvent.tripleClick(field);
  await userEvent.keyboard("Quokka = new");
  const results = await within(panel).findByRole("list", { name: "Search results" });
  await within(results).findByRole("button", { name: "src/other.ts, 1 result" });
  expect(within(results).queryByRole("button", { name: /^docs\/notes\.md/ })).toBeNull();
  expect(await within(panel).findByText("1 result in 1 file")).toBeTruthy();
  // Each search ran once typing paused, not once per key, and the first was called off.
  expect(searches.map((search) => search.pattern)).toEqual(["Wombat", "Quokka = new"]);
  expect(searches[0]?.signal?.aborted).toBe(true);
});

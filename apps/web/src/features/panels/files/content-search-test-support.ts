import { coldStartReplay } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

export const thread = "thread-cold-start";

/** The thread's Files tab, its checkout seeded with a few files to search, on its Search side. */
export async function openSearch(
  options: { hold?: string; files?: Readonly<Record<string, string>> } = {},
) {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  app.daemon.checkouts.seed(
    thread,
    "src/cache.ts",
    "const a = 1;\nconst hit = quokka.get(key);\n  quokka.set(key, hit);\n",
  );
  app.daemon.checkouts.seed(thread, "src/other.ts", "export const Quokka = new Map();\n");
  app.daemon.checkouts.seed(thread, "docs/notes.md", "Wombat notes.\n");
  for (const [path, text] of Object.entries(options.files ?? {}))
    app.daemon.checkouts.seed(thread, path, text);
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
  return { app, panel, field, searches, folders };
}

import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * The gutter's marks against the last commit in the app's editor: they stay while the person
 * types, and the lines typed join them, all against what git has committed.
 */

const thread = "thread-cold-start";
const source = "export function retry() {\n  return 3;\n}\nexport const tries = 2;\n";
const patch = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,4 +1,4 @@",
  " export function retry() {",
  "-  return 1;",
  "+  return 3;",
  " }",
  "-export const tries = 1;",
  "+export const tries = 2;",
  "",
].join("\n");

const marks = (view: HTMLElement) =>
  [...view.querySelectorAll("[data-change-bar]")].map((bar) => [
    bar.getAttribute("data-change-line"),
    bar.getAttribute("data-change-bar"),
  ]);

test("marks against the last commit stay while the person types, and typed lines join them", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  app.daemon.checkouts.seed(thread, "src/retry.ts", source);
  app.daemon.workspace.setGitDiff(thread, patch);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "retry.ts");
  await screen.findByRole("option", { name: /retry\.ts/ });
  await userEvent.keyboard("{Enter}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const view = await within(panel).findByRole("region", { name: "Source of src/retry.ts" });
  await waitFor(() =>
    expect(marks(view)).toEqual([
      ["2", "modified"],
      ["4", "modified"],
    ]),
  );

  // A new line under the function: unsaved, and added since the last commit.
  await userEvent.click(within(panel).getByRole("textbox", { name: "retry.ts" }));
  await userEvent.keyboard("{Control>}{End}{/Control}// typed");
  await waitFor(() =>
    expect(marks(view)).toEqual([
      ["2", "modified"],
      ["4", "modified"],
      ["5", "added"],
    ]),
  );
});

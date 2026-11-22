import { coldStartReplay } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { bytes } from "../files/tree-test-queries.ts";

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

test("Revert puts back the committed text byte for byte: no newline where the commit had none", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  app.daemon.checkouts.seed(thread, "src/eol.ts", "one\nTWO\n");
  app.daemon.workspace.setGitDiff(
    thread,
    [
      "diff --git a/src/eol.ts b/src/eol.ts",
      "--- a/src/eol.ts",
      "+++ b/src/eol.ts",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "\\ No newline at end of file",
      "+TWO",
      "",
    ].join("\n"),
  );
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "eol.ts");
  await screen.findByRole("option", { name: /eol\.ts/ });
  await userEvent.keyboard("{Enter}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const view = await within(panel).findByRole("region", { name: "Source of src/eol.ts" });
  await waitFor(() => expect(marks(view)).toEqual([["2", "modified"]]));

  const number = view.querySelector<HTMLElement>('[data-line="1"] [data-line-number]');
  const scroller = view.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!number || !scroller) throw new Error("no gutter");
  fireEvent.pointerDown(scroller, {
    button: 0,
    clientX: Number.parseFloat(number.style.width) - 2,
    clientY: 22 + 5,
  });
  const peek = await within(view).findByRole("group", { name: "Change at line 2" });
  await userEvent.click(within(peek).getByRole("button", { name: "Revert" }));
  await userEvent.click(within(panel).getByRole("textbox", { name: "eol.ts" }));
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(async () => expect(await bytes(app, "src/eol.ts")).toBe("one\ntwo"));
});

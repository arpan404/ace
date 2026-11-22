import { coldStartReplay } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { bytes } from "../files/tree-test-queries.ts";

configure({ asyncUtilTimeout: 10_000 });

/*
 * Revert is the person's to save, even with auto save on (Settings › Editor › After a pause):
 * the reverted lines, landed through the mounted editor, never reach the disk without ⌘S, and a
 * pending auto save of the file is called off.
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
  " export const tries = 2;",
  "",
].join("\n");

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a Revert with auto save on stays unsaved until the person saves", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.editor.preferences",
    JSON.stringify({ autoSave: "pause", autoSaveDelay: 300 }),
  );
  const app = harness({ storage });
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
  await waitFor(() => expect(view.querySelector('[data-change-line="2"]')).toBeTruthy());

  // Typing first: an auto save of the file is waiting when the person reverts.
  await userEvent.click(within(panel).getByRole("textbox", { name: "retry.ts" }));
  await userEvent.keyboard("{Control>}{End}{/Control}// typed");
  const number = view.querySelector<HTMLElement>('[data-line="1"] [data-line-number]');
  const scroller = view.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!number || !scroller) throw new Error("no gutter");
  await waitFor(() => expect(view.querySelector('[data-change-line="5"]')).toBeTruthy());
  fireEvent.pointerDown(scroller, {
    button: 0,
    clientX: Number.parseFloat(number.style.width) - 2,
    clientY: 22 + 5,
  });
  const peek = await within(view).findByRole("group", { name: "Change at line 2" });
  await userEvent.click(within(peek).getByRole("button", { name: "Revert" }));
  await waitFor(() => expect(view.textContent).toContain("return 1;"));

  // Well past the auto save's pause, nothing was written.
  await pause(1_000);
  expect(await bytes(app, "src/retry.ts")).toBe(source);

  await userEvent.click(within(panel).getByRole("textbox", { name: "retry.ts" }));
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(async () =>
    expect(await bytes(app, "src/retry.ts")).toBe(
      "export function retry() {\n  return 1;\n}\nexport const tries = 2;\n// typed",
    ),
  );
});

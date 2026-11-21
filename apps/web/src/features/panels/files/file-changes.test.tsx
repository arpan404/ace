import { coldStartReplay } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { codeText } from "@/test/code-text.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { bytes } from "./tree-test-queries.ts";

configure({ asyncUtilTimeout: 10000 });

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

async function openRetry(storage = memoryKeyValue()) {
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
  await waitFor(() => expect(view.textContent).toContain("return 3;"));
  return { app, panel, view };
}

test("a file's lines changed since the last commit are marked beside their numbers", async () => {
  const { view } = await openRetry();
  await waitFor(() =>
    expect(
      within(view)
        .getAllByTitle("Changed since the last commit")
        .map((gutter) => gutter.textContent),
    ).toEqual(["2", "4"]),
  );
  // Unchanged lines carry no mark.
  expect(within(view).queryAllByTitle(/since the last commit/)).toHaveLength(2);
});

test("a changed file opens its uncommitted diff in Changes from its tab's menu", async () => {
  const { panel } = await openRetry();
  const tab = within(panel).getByRole("tab", { name: "retry.ts" });
  await userEvent.pointer({ target: tab, keys: "[MouseRight]" });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Show uncommitted changes" }));
  expect(await within(panel).findByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  const diff = await within(panel).findByLabelText("Uncommitted diff");
  const file = within(diff).getByRole("region", { name: "src/retry.ts" });
  expect(within(file).getByText(codeText(/return 1;/))).toBeTruthy();
  expect(within(file).getByText(codeText(/return 3;/))).toBeTruthy();
});

test("typed text marks the tab unsaved and stays out of the stored layout", async () => {
  const storage = memoryKeyValue();
  const { panel, view } = await openRetry(storage);
  // Always editable: no mode to enter first.
  const editor = await within(panel).findByRole("textbox", { name: "retry.ts" });
  await userEvent.click(editor);
  await userEvent.keyboard("{Control>}a{/Control}");
  await userEvent.keyboard("// typed");
  const tab = within(panel).getByRole("tab", { name: "retry.ts" });
  await waitFor(() =>
    expect(tab.querySelector("[data-shows]")?.getAttribute("data-shows")).toBe("unsaved"),
  );
  expect(view.textContent).toContain("// typed");
  // The layout (with its tab) is stored; the unsaved text goes to the device's draft store.
  await waitFor(() => expect(storage.getItem("ace.workspace") ?? "").toContain("src/retry.ts"));
  expect(storage.getItem("ace.workspace") ?? "").not.toContain("// typed");
});

/** Presses a changed line's bar at the gutter's right edge. */
function pressMark(view: HTMLElement, line: number) {
  const gutter = view.querySelector<HTMLElement>(`[data-line="${line - 1}"] [data-mark]`);
  const scroller = view.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!gutter || !scroller) throw new Error(`line ${line} has no mark`);
  const width = Number.parseFloat(gutter.style.width);
  fireEvent.pointerDown(scroller, { button: 0, clientX: width - 2, clientY: (line - 1) * 22 + 5 });
}

test("a press on a change mark shows what the lines were, and Revert puts them back and saves", async () => {
  const { app, view } = await openRetry();
  await waitFor(() =>
    expect(within(view).getAllByTitle("Changed since the last commit")).toHaveLength(2),
  );
  pressMark(view, 2);
  const peek = await within(view).findByRole("group", { name: "Change at line 2" });
  expect(peek.textContent).toContain("1 line changed since the last commit");
  expect(
    [...peek.querySelectorAll("[data-hunk-line]")].map((line) => [
      line.getAttribute("data-hunk-line"),
      line.textContent,
    ]),
  ).toEqual([
    ["removed", "−   return 1;"],
    ["added", "+   return 3;"],
  ]);

  await userEvent.click(within(peek).getByRole("button", { name: "Revert" }));
  await waitFor(async () =>
    expect(await bytes(app, "src/retry.ts")).toBe(
      "export function retry() {\n  return 1;\n}\nexport const tries = 2;\n",
    ),
  );
  expect(view.textContent).toContain("return 1;");
  expect(within(view).queryByRole("group", { name: /^Change at line/ })).toBeNull();
});

test("Close and Escape put a change's inline diff away without touching the file", async () => {
  const { app, view } = await openRetry();
  await waitFor(() =>
    expect(within(view).getAllByTitle("Changed since the last commit")).toHaveLength(2),
  );
  pressMark(view, 4);
  const peek = await within(view).findByRole("group", { name: "Change at line 4" });
  await userEvent.click(within(peek).getByRole("button", { name: "Close" }));
  expect(within(view).queryByRole("group", { name: /^Change at line/ })).toBeNull();
  pressMark(view, 2);
  const again = await within(view).findByRole("group", { name: "Change at line 2" });
  within(again).getByRole("button", { name: "Close" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(within(view).queryByRole("group", { name: /^Change at line/ })).toBeNull();
  expect(await bytes(app, "src/retry.ts")).toBe(source);
});

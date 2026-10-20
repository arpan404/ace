import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { codeText } from "@/test/code-text.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

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

test("a changed file opens its uncommitted diff in Changes", async () => {
  const { panel } = await openRetry();
  await userEvent.click(
    await within(panel).findByRole("button", { name: "Show uncommitted changes" }),
  );
  expect(within(panel).getByRole("button", { name: "Scope: Uncommitted" })).toBeTruthy();
  const diff = await within(panel).findByLabelText("Uncommitted diff");
  const file = within(diff).getByRole("region", { name: "src/retry.ts" });
  expect(within(file).getByText(codeText(/return 1;/))).toBeTruthy();
  expect(within(file).getByText(codeText(/return 3;/))).toBeTruthy();
});

test("text typed in the editor is kept for the tab once typing pauses", async () => {
  const storage = memoryKeyValue();
  const { panel } = await openRetry(storage);
  await userEvent.click(within(panel).getByRole("button", { name: "Edit file" }));
  const editor = await within(panel).findByRole("textbox", { name: "Edit src/retry.ts" });
  await userEvent.type(editor, "// typed");
  await waitFor(() => expect(storage.getItem("ace.workspace") ?? "").toContain("// typed"));
  expect((editor as HTMLTextAreaElement).value).toContain("// typed");
});

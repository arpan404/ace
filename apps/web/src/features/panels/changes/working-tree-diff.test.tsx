import { replayCursor } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { codeText } from "@/test/code-text.ts";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-replay-cursor";
const patch = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,3 +1,3 @@",
  " export function retry() {",
  "-  return 1;",
  "+  return 3;",
  " }",
  "diff --git a/docs/notes.md b/docs/notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+Shell-made file",
  "",
].join("\n");

async function openUncommitted() {
  const app = harness();
  app.play(replayCursor()).runThrough("asked");
  app.daemon.workspace.setGitDiff(thread, patch);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
  await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: /Changes/ }));
  return within(panel).findByLabelText("Uncommitted diff");
}

test("uncommitted changes show each file with its added and removed lines", async () => {
  const diff = await openUncommitted();
  const retry = within(diff).getByRole("region", { name: "src/retry.ts" });
  const removed = within(retry)
    .getByText(codeText(/return 1;/))
    .closest("[data-diff-row]");
  const added = within(retry)
    .getByText(codeText(/return 3;/))
    .closest("[data-diff-row]");
  // Old and new line numbers sit in the gutter; the line's sign is read out with its text.
  expect(removed?.textContent).toMatch(/^2\s*−\s*return 1;$/);
  expect(added?.textContent).toMatch(/^2\s*\+\s*return 3;$/);
  // The patch's own headers are not shown as lines.
  expect(diff.textContent).not.toContain("diff --git");
  expect(diff.textContent).not.toContain("@@");

  const notes = within(diff).getByRole("region", { name: "docs/notes.md" });
  expect(within(notes).getByText("added")).toBeTruthy();
  expect(within(notes).getByText(codeText(/Shell-made file/))).toBeTruthy();

  // Each file folds from its header, as in the agents' edits.
  const header = within(notes).getByRole("button", { name: /notes\.md/, expanded: true });
  await userEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(within(notes).queryByText(codeText(/Shell-made file/))).toBeNull();
});

test("uncommitted files list in the files tree and jump to their diff", async () => {
  const diff = await openUncommitted();
  const tree = await screen.findByRole("tree", { name: "Changed files" });
  expect(within(tree).getByRole("treeitem", { name: "src/retry.ts" })).toBeTruthy();
  const notes = within(tree).getByRole("treeitem", { name: "docs/notes.md" });
  await userEvent.click(notes);
  expect(notes.getAttribute("aria-selected")).toBe("true");
  expect(within(diff).getByRole("region", { name: "docs/notes.md" })).toBeTruthy();
});

test("uncommitted files carry no review controls", async () => {
  const diff = await openUncommitted();
  const retry = within(diff).getByRole("region", { name: "src/retry.ts" });
  await waitFor(() => expect(within(retry).getByText(codeText(/return 3;/))).toBeTruthy());
  expect(within(retry).queryByRole("button", { name: "Viewed" })).toBeNull();
  expect(within(retry).queryByRole("button", { name: /^Comment on/ })).toBeNull();
  expect(within(retry).getByRole("button", { name: "Actions for src/retry.ts" })).toBeTruthy();
});

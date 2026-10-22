import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ForgeMergeCommit } from "@ace/protocol";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { MergeCommitForm } from "./pr-merge-commit.tsx";

const form = (prefill: ForgeMergeCommit, headSha: string, sent: ForgeMergeCommit[] = []) => (
  <Dialog open>
    <DialogContent>
      <MergeCommitForm
        heading="Squash and merge into main"
        confirm="Confirm squash and merge"
        prefill={prefill}
        headSha={headSha}
        blocked={undefined}
        onCancel={() => {}}
        onSubmit={(commit) => sent.push(commit)}
      />
    </DialogContent>
  </Dialog>
);
const first = { title: "Fix build (#7)", message: "* Fix build" };
const pushed = { title: "Fix build (#7)", message: "* Fix build\n* Add test" };

test("a push keeps the edited title, follows GitHub for the untouched message, and says the branch moved", async () => {
  const sent: ForgeMergeCommit[] = [];
  const view = render(form(first, "a".repeat(40), sent));
  const title = screen.getByRole<HTMLInputElement>("textbox", { name: "Commit title" });
  await userEvent.clear(title);
  await userEvent.type(title, "Fix the build for good (#7)");
  view.rerender(form(pushed, "b".repeat(40), sent));
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Commit title" }).value).toBe(
    "Fix the build for good (#7)",
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Commit message" }).value).toBe(
    "* Fix build\n* Add test",
  );
  expect(screen.getByText(/The branch has new commits since this opened/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Confirm squash and merge" }));
  expect(sent).toEqual([{ title: "Fix the build for good (#7)", message: "* Fix build\n* Add test" }]);
});

test("an edited message keeps its words when GitHub's text changes, and can take the new text on request", async () => {
  const view = render(form(first, "a".repeat(40)));
  const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Commit message" });
  await userEvent.type(message, "\n\nCloses #3");
  view.rerender(form(pushed, "b".repeat(40)));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Commit message" }).value).toBe(
    "* Fix build\n\nCloses #3",
  );
  await userEvent.click(screen.getByRole("button", { name: "Use GitHub's new text" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Commit message" }).value).toBe(
    "* Fix build\n* Add test",
  );
});

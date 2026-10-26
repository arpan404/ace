import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { WorkspaceId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

function withRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  return app;
}
const listed = async () =>
  within(await screen.findByRole("navigation", { name: "Pull requests" }))
    .queryAllByRole("link")
    .flatMap((row) => /#(\d+)/.exec(row.textContent ?? "")?.[1] ?? []);

test("a pull request no thread is linked to merges from the page and leaves the open list", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/224");
  const panel = await screen.findByRole("article", { name: "Pull request #224" });
  const merge = await within(panel).findByRole("button", { name: "Squash and merge" });
  await userEvent.click(merge);
  // The commit GitHub writes opens to edit; confirming it merges.
  const commit = await screen.findByRole("dialog", { name: "Squash and merge into main" });
  await userEvent.click(within(commit).getByRole("button", { name: "Confirm squash and merge" }));
  // Merged: the state shows once, as the badge under the title, and the merge button is gone.
  expect(await within(panel).findByText("Merged")).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: /merge/i })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Back to pull requests" }));
  await waitFor(async () => expect(await listed()).not.toContain("224"));
});

test("a pull request that conflicts with its base offers to resolve the conflicts, not to merge", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/226");
  const panel = await screen.findByRole("article", { name: "Pull request #226" });
  expect(await within(panel).findByRole("button", { name: "Resolve conflicts" })).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: /merge$/i })).toBeNull();
});

test("a pull request with failing checks and requested changes can't merge and says why", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/229");
  const panel = await screen.findByRole("article", { name: "Pull request #229" });
  const blocked = await within(panel).findByRole("button", { name: "Merge blocked" });
  expect((blocked as HTMLButtonElement).disabled).toBe(true);
  expect(within(panel).getByText(/1 failing/)).toBeTruthy();
  expect(within(panel).getByText("Changes requested")).toBeTruthy();
});

test("an unlinked pull request waiting on checks and review turns auto-merge on, then off", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/231");
  const panel = await screen.findByRole("article", { name: "Pull request #231" });
  await userEvent.click(
    await within(panel).findByRole("button", { name: "Enable auto-merge · squash" }),
  );
  const commit = await screen.findByRole("dialog", {
    name: "Squash and merge into main automatically",
  });
  await userEvent.click(within(commit).getByRole("button", { name: "Enable auto-merge" }));
  // At narrow widths the words after the first " · " step aside on screen, in their own span.
  expect(
    await within(panel).findByText(
      (_, element) =>
        element?.tagName === "SPAN" && element.textContent === "Auto-merge on · squash · by you",
    ),
  ).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Disable" }));
  expect(
    await within(panel).findByRole("button", { name: "Enable auto-merge · squash" }),
  ).toBeTruthy();
});

test("where the repository doesn't allow auto-merge, a PR waiting on checks can't merge and says why", async () => {
  const app = withRepository();
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.merge-state",
      workspaceId: WorkspaceId.parse("ace"),
      repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
      number: 231,
    },
    {
      resource: "prMergeState",
      value: {
        headSha: (231).toString(16).padStart(40, "e"),
        state: "OPEN",
        mergeState: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        checksState: "PENDING",
        autoMerge: null,
        queue: null,
        canEnable: false,
        canDisable: false,
        canDequeue: false,
        blockers: [],
        raw: {},
      },
    },
  );
  await app.open("/pulls/ace/231");
  const panel = await screen.findByRole("article", { name: "Pull request #231" });
  const merge = await within(panel).findByRole("button", { name: "Squash and merge" });
  expect((merge as HTMLButtonElement).disabled).toBe(true);
  await userEvent.hover(merge.parentElement ?? merge);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "This repository doesn't allow auto-merge for this account.",
  );
});

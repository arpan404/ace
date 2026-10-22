import { expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pullRequestDetails, workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

const repository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "docs-site",
} as const;

/** PR #31 of acme/docs-site, "Rewrite the install page for the daemon", its comment box open. */
async function commentBox() {
  // Each test starts with an empty comment: drafts are kept on this device.
  localStorage.clear();
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.seedPullRequests(pullRequestDetails(1_000));
  await openPullRequest(app, { project: "api", repository, number: 31 });
  await screen.findByRole("article", { name: "Pull request #31" }, { timeout: 10_000 });
  await userEvent.click(await screen.findByRole("button", { name: "Write a comment or review" }));
  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "PR conversation comment" });
}

const rows = async () =>
  within(
    await screen.findByRole("listbox", { name: "Issues and pull requests" }, { timeout: 3_000 }),
  )
    .getAllByRole("option")
    .map((row) => row.getAttribute("aria-label"));

// The fake searches as GitHub does: whole title words only, never a word's beginning.
test("# finds an item by the beginning of a title word, as the word is still being typed", async () => {
  const field = await commentBox();
  await userEvent.type(field, "see #Rewri");
  expect(await rows()).toEqual(["#31 Rewrite the install page for the daemon, open pull request"]);
});

test("# finds an item by finished title words and the beginning of the next", async () => {
  const field = await commentBox();
  await userEvent.type(field, "see #Rewrite the inst");
  expect(await rows()).toEqual(["#31 Rewrite the install page for the daemon, open pull request"]);
  await userEvent.type(field, "{ArrowDown}{Enter}");
  expect(field.value).toBe("see #31 ");
});

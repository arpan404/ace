import { expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { pullRequestDetails, workbench } from "@ace/fake-daemon";
import { WorkspaceId } from "@ace/protocol";
import { createQueryClient } from "@/app.tsx";
import { prDetailKey } from "@/lib/forge-pr-detail.ts";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

const repository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "docs-site",
} as const;

/** PR #31 of acme/docs-site: mira asked for changes, dana commented, ola is still asked. */
async function openInstallPage(queryClient = createQueryClient()) {
  const app = harness({ queryClient });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.seedPullRequests(pullRequestDetails(1_000));
  await openPullRequest(app, { project: "api", repository, number: 31 });
  await screen.findByRole("article", { name: "Pull request #31" }, { timeout: 10_000 });
  return app;
}

const reviewers = () => screen.findByRole("button", { name: /^Reviewers: mira/ });
const list = async () => {
  const button = await reviewers();
  if (button.getAttribute("aria-expanded") !== "true") await userEvent.click(button);
  return screen.findByRole("dialog");
};
const row = async (name: string) =>
  (await within(await list()).findByText(name)).closest("li") as HTMLElement;

test("each reviewer shows their latest review, and a verdict can be dismissed with a reason", async () => {
  await openInstallPage();
  await waitFor(async () =>
    expect((await reviewers()).getAttribute("aria-label")).toBe(
      "Reviewers: mira, Changes requested; dana, Commented; ola, Awaiting review",
    ),
  );
  // A comment has no verdict to take back.
  expect(within(await row("dana")).queryByRole("button", { name: /Dismiss/ })).toBeNull();
  await userEvent.click(
    within(await row("mira")).getByRole("button", { name: "Dismiss mira's review" }),
  );
  const submit = screen.getByRole("button", { name: "Dismiss review" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Why dismiss mira's review" }),
    "The port is fixed",
  );
  await userEvent.click(submit);
  await waitFor(async () => expect(within(await row("mira")).getByText("Dismissed")).toBeTruthy());
}, 30_000);

test("a reviewer is asked again after reviewing, and a pending request can be withdrawn", async () => {
  await openInstallPage();
  await userEvent.click(within(await row("mira")).getByRole("button", { name: "Re-request" }));
  await waitFor(async () =>
    expect(within(await row("mira")).getByText("Changes requested · asked again")).toBeTruthy(),
  );
  await userEvent.click(
    within(await row("ola")).getByRole("button", { name: "Remove ola from reviewers" }),
  );
  await waitFor(async () => expect(within(await list()).queryByText("ola")).toBeNull());
}, 30_000);

test("the request picker offers GitHub's suggestions and Enter asks the ones picked", async () => {
  await openInstallPage();
  await userEvent.click(within(await list()).getByRole("button", { name: "Request review" }));
  const field = await screen.findByRole("textbox", { name: "Reviewers" });
  const suggested = await screen.findByRole("region", { name: "Suggested" });
  await userEvent.click(within(suggested).getByRole("button", { name: "jonas, Jonas Becker" }));
  expect((field as HTMLInputElement).value).toBe("jonas, ");
  expect(document.activeElement).toBe(field);
  await userEvent.type(field, "acme/docs{Enter}");
  await waitFor(async () =>
    expect((await reviewers()).getAttribute("aria-label")).toContain(
      "jonas, Awaiting review; docs, Awaiting review",
    ),
  );
}, 30_000);

test("the reviewers are read once, not again each time the window regains focus", async () => {
  const app = await openInstallPage();
  const read = {
    op: "forge.pr.reviewers" as const,
    workspaceId: WorkspaceId.parse("api"),
    repository: { ...repository },
    number: 31,
  };
  await waitFor(async () =>
    expect((await reviewers()).getAttribute("aria-label")).toContain("mira, Changes requested"),
  );
  const before = app.daemon.workspace.forgeReadCount(read);
  expect(before).toBe(1);
  for (let i = 0; i < 3; i++)
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(app.daemon.workspace.forgeReadCount(read)).toBe(before);
  focusManager.setFocused(undefined);
}, 30_000);

test("on the Code tab, an approval that arrives with the PR clears the Changes requested gate", async () => {
  const queryClient = createQueryClient();
  const app = await openInstallPage(queryClient);
  await userEvent.click(await screen.findByRole("tab", { name: "Code" }));
  // Summary (and its Reviewers line) is gone; only the PR view remains to follow.
  await waitFor(() => expect(screen.queryByRole("group", { name: "Reviewers" })).toBeNull());
  await screen.findByRole("button", { name: "Reviews: Changes requested" });
  app.daemon.workspace.submitPullRequestReview(31, {
    login: "mira",
    state: "APPROVED",
    at: "2026-10-22T12:00:00.000Z",
  });
  // The PR's own poll brings the new detail; nothing else is read again by hand.
  await act(() => queryClient.refetchQueries({ queryKey: prDetailKey("api", repository, 31) }));
  await screen.findByRole("button", { name: "Reviews: 1 approved" }, { timeout: 5_000 });
}, 30_000);

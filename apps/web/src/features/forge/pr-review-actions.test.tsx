import { expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { workbench } from "@ace/fake-daemon";
import { ForgePrDetail, ForgeReviewState, WorkspaceId } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";
import { reviewHarness } from "./review-harness.tsx";
import { PrComments } from "./pr-comments.tsx";
import { PrReactions } from "./pr-reactions.tsx";
import { PrSuggestionBatch } from "./pr-suggestions.tsx";
import { openPullRequest } from "./test-support.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const headSha = "a".repeat(40);
const inline = (id: number, body: string) => ({
  kind: "inline",
  id,
  author: "reviewer",
  body,
  file: "src/main.ts",
  line: id,
  updatedAt: "2026-10-10",
  replyTo: null,
});
const thread = (id: string, comment: ReturnType<typeof inline>, outdated = false) => ({
  id,
  resolved: false,
  outdated,
  file: "src/main.ts",
  line: comment.line,
  comments: [comment],
});
const detail = ForgePrDetail.parse({
  status: {
    ref: { repository, number: 42 },
    title: "Review",
    url: "https://github.com/acme/api/pull/42",
    headSha,
    state: "open",
    mergeability: "unknown",
    ci: "none",
    checks: [],
    comments: [],
    reviewThreads: [
      thread("T1", inline(7, "Name it.\n```suggestion\nconst count = 1;\n```")),
      thread("T2", inline(8, "```suggestion\n```")),
      thread("T3", inline(9, "```suggestion\nold\n```"), true),
    ],
    raw: {},
  },
  body: "Description",
  author: "author",
  headBranch: "feature",
  baseBranch: "main",
  baseSha: "b".repeat(40),
  headRepository: repository,
  labels: [],
  reviewers: [],
  reviewDecision: null,
  commits: 1,
  changedFiles: 1,
  relatedThreads: [],
  relatedThreadsTruncated: false,
});
const reviewState = ForgeReviewState.parse({
  viewer: "reviewer",
  headSha,
  drafts: [],
  viewed: null,
  canReview: true,
  canComment: true,
  resolvableThreads: [],
  operations: [],
  reactions: [
    {
      subject: { kind: "pr" },
      groups: [
        { content: "heart", count: 2, viewer: true },
        { content: "+1", count: 1, viewer: false },
      ],
    },
  ],
});

/** The review workspace with every hosted review command accepted and recorded. */
function reviewPanel() {
  return reviewHarness({
    detail,
    state: reviewState,
    ui: (
      <>
        <PrSuggestionBatch />
        <PrReactions subject={{ kind: "pr" }} />
        <PrComments status={detail.status} />
      </>
    ),
  });
}

test("reactions show their counts with the viewer's own pressed, and pressing one toggles it on GitHub", async () => {
  const f = await reviewPanel();
  try {
    const heart = await screen.findByRole("button", { name: "Heart: 2, including you" });
    expect(heart.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Thumbs up: 1" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await userEvent.click(heart);
    await waitFor(() => expect(f.sent).toHaveLength(1));
    // The description's picker comes first; every comment has its own.
    await userEvent.click(screen.getAllByRole("button", { name: "Add reaction" })[0]!);
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Rocket" }));
    await waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent).toEqual([
      { kind: "reaction.remove", subject: { kind: "pr" }, content: "heart" },
      { kind: "reaction.add", subject: { kind: "pr" }, content: "rocket" },
    ]);
  } finally {
    await f.close();
  }
});

test("a suggestion commits on its own or with others as one batch, never from an outdated line", async () => {
  const f = await reviewPanel();
  try {
    await screen.findByRole("button", { name: "Heart: 2, including you" });
    // The outdated thread's suggestion offers nothing to commit.
    expect(screen.getAllByRole("button", { name: "Commit suggestion" })).toHaveLength(2);
    const named = screen.getByText("Name it.").closest("li");
    if (!named) throw new Error("Missing the named suggestion's thread");
    await userEvent.click(within(named).getByRole("button", { name: "Commit suggestion" }));
    const message = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Commit message",
    });
    expect(message.value).toBe("Apply suggestion from @reviewer");
    await userEvent.click(screen.getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(f.sent).toHaveLength(1));
    for (const button of screen.getAllByRole("button", { name: "Add to batch" }))
      await userEvent.click(button);
    const batch = screen.getByRole("group", { name: "Suggestion batch" });
    await userEvent.click(within(batch).getByRole("button", { name: "Commit 2 suggestions" }));
    await userEvent.click(await screen.findByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[0]).toEqual({
      kind: "suggestions.apply",
      headSha,
      commentIds: [7],
      message: "Apply suggestion from @reviewer",
    });
    const second = f.sent[1];
    expect(second?.kind === "suggestions.apply" && second.commentIds.toSorted()).toEqual([7, 8]);
    expect(second).toMatchObject({ headSha, message: "Apply suggestions from code review" });
    // Committed, the batch empties.
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Suggestion batch" })).toBeNull(),
    );
  } finally {
    await f.close();
  }
});

test("a reviewer can be requested from the PR panel when no task is linked to the pull request", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const operation = {
    op: "forge.pr.detail",
    workspaceId: WorkspaceId.parse("api"),
    number: 42,
  } as const;
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prDetail",
    value: { ...detail, status: { ...detail.status, reviewThreads: [] } },
  });
  // GitHub refuses, so the panel says what GitHub said about this request.
  app.daemon.refuseCommands("forge_forbidden", "forge.hosted.review");
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  const item = await screen.findByRole("menuitem", { name: "Request review…" });
  expect(item.getAttribute("aria-disabled")).not.toBe("true");
  await userEvent.click(item);
  await userEvent.type(await screen.findByRole("textbox", { name: "Reviewers" }), "ana");
  await userEvent.click(screen.getByRole("button", { name: "Request review" }));
  expect(
    await screen.findByText(
      "GitHub denied access: check your permissions on the repository, or run `gh auth login`.",
    ),
  ).toBeTruthy();
}, 30_000);

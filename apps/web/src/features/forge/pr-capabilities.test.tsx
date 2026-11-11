import { expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CommandId,
  ForgeMergeState,
  ForgePrDetail,
  WorkspaceId,
  type ForgeRepository,
} from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { repositoryParam } from "@/lib/pull-request-route.ts";

const workspaceId = WorkspaceId.parse("api");
const origin = {
  forge: "origin",
  host: "origin.cursor.com",
  owner: "acme",
  name: "api",
} as const satisfies ForgeRepository;
const gitlab = {
  forge: "gitlab",
  host: "gitlab.example.com",
  owner: "acme",
  name: "api",
} as const satisfies ForgeRepository;

function hosted(
  repository: ForgeRepository,
  number: number,
  patch: {
    title?: string;
    body?: string;
    changedFiles?: number;
    files?: boolean;
    fileCount?: boolean;
  } = {},
) {
  const url =
    repository.forge === "origin"
      ? `https://cursor.com/codebase/acme/api/pull/${number}`
      : `https://${repository.host}/acme/api/-/merge_requests/${number}`;
  return ForgePrDetail.parse({
    readOnly: true,
    unavailableResources: [
      "comments",
      "checks",
      "reviews",
      "commits",
      ...(patch.files === false ? ["files"] : []),
      ...(patch.fileCount === false ? ["fileCount"] : []),
    ],
    status: {
      ref: { repository, number },
      title: patch.title ?? "Retry reconnects",
      url,
      headSha: "a".repeat(40),
      state: "open",
      mergeability: "unknown",
      ci: "unknown",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: patch.body ?? "",
    author: "author",
    headBranch: "fix/reconnect",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: repository,
    labels: [],
    reviewers: [],
    reviewDecision: null,
    commits: 1,
    changedFiles: patch.changedFiles ?? 1,
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
}

function withDetails(...details: ForgePrDetail[]) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  for (const detail of details) {
    const { repository, number } = detail.status.ref;
    app.daemon.workspace.setForgeRead(
      { op: "forge.pr.detail", workspaceId, repository, number },
      { resource: "prDetail", value: detail },
    );
    app.daemon.workspace.setForgeRead(
      {
        op: "forge.pr.files",
        workspaceId,
        repository,
        number,
        page: 1,
        headSha: detail.status.headSha,
        baseSha: detail.baseSha,
      },
      {
        resource: "prFiles",
        value: {
          ref: detail.status.ref,
          headSha: detail.status.headSha,
          baseSha: detail.baseSha,
          files: [
            {
              path: "hosted-change.ts",
              status: "added",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+export const hosted = true;",
              truncated: false,
            },
          ],
          truncated: false,
        },
      },
    );
  }
  return app;
}

const page = (repository: ForgeRepository, number: number) =>
  `/pulls/api/${number}?repo=${encodeURIComponent(repositoryParam(repository))}`;

test("an Origin pull request shows its details and diffs without GitHub's write controls", async () => {
  const app = withDetails(hosted(origin, 42));
  await app.open(page(origin, 42));
  expect(await screen.findByRole("link", { name: "Open on Cursor Origin" })).toHaveProperty(
    "href",
    "https://cursor.com/codebase/acme/api/pull/42",
  );
  expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /review/i })).toBeNull();
  const tabs = screen.getByRole("tablist", { name: "Pull request detail" });
  expect(within(tabs).getByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
  await userEvent.click(within(tabs).getByRole("tab", { name: /^Code/ }));
  expect((await screen.findAllByText("hosted-change.ts")).length).toBeGreaterThan(0);
  expect(within(tabs).getByRole("tab", { name: /^Code/, selected: true })).toBeTruthy();
});

test("a merge request whose host reports its files lists them under Code with their count", async () => {
  const app = withDetails({
    ...hosted(gitlab, 9, { changedFiles: 3 }),
    reviewers: ["you"],
    capabilities: ["reviews.read", "reviews.files"],
  });
  await app.open(page(gitlab, 9));
  const tabs = await screen.findByRole("tablist", { name: "Pull request detail" });
  const code = within(tabs).getByRole("tab", { name: /^Code/ });
  expect(code.textContent).toBe("Code3");
  expect(screen.queryByRole("group", { name: "Reviewers" })).toBeNull();
  expect(screen.getByRole("link", { name: "Open on GitLab" })).toBeTruthy();
  await userEvent.click(code);
  expect((await screen.findAllByText("hosted-change.ts")).length).toBeGreaterThan(0);
});

test("a merge request whose host gives no file count shows Code without a number and still lists files", async () => {
  // Whatever placeholder the count carries, the page never shows it as a number.
  const app = withDetails(hosted(gitlab, 9, { fileCount: false, changedFiles: 4 }));
  await app.open(page(gitlab, 9));
  const tabs = await screen.findByRole("tablist", { name: "Pull request detail" });
  const code = within(tabs).getByRole("tab", { name: /^Code/ });
  expect(code.textContent).toBe("Code");
  await userEvent.click(code);
  expect((await screen.findAllByText("hosted-change.ts")).length).toBeGreaterThan(0);
});

test("a merge request whose host can't share its files says so instead of an empty list", async () => {
  const app = withDetails(hosted(gitlab, 9, { files: false, changedFiles: 0 }));
  await app.open(page(gitlab, 9));
  const tabs = await screen.findByRole("tablist", { name: "Pull request detail" });
  await userEvent.click(within(tabs).getByRole("tab", { name: "Code" }));
  expect(
    await screen.findByText("GitLab doesn't share this merge request's changed files with ace.", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(screen.queryByText("No changed files on this page.")).toBeNull();
  expect(screen.queryByText("hosted-change.ts")).toBeNull();
});

test("#7 in an Origin description opens review 7 of the same repository here", async () => {
  const app = withDetails(
    hosted(origin, 42, { body: "Follows #7." }),
    hosted(origin, 7, { title: "Earlier reconnect fix" }),
  );
  await app.open(page(origin, 42));
  await userEvent.click(await screen.findByRole("link", { name: "#7" }));
  const next = await screen.findByRole("article", { name: "Pull request #7" });
  expect(await within(next).findByText("Earlier reconnect fix")).toBeTruthy();
  await waitFor(() =>
    expect(within(next).getByText(/Some review actions are available only/)).toBeTruthy(),
  );
});

test("explicit comment writing enables a GitLab conversation without approval or merge controls", async () => {
  const detail = {
    ...hosted(gitlab, 10),
    capabilities: ["reviews.read", "reviews.files", "reviews.comments.write"],
  };
  const app = withDetails(detail);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId, repository: gitlab, number: 10 },
    {
      resource: "prReviewState",
      value: {
        viewer: "me",
        headSha: detail.status.headSha,
        drafts: [],
        viewed: null,
        canReview: true,
        canComment: true,
        resolvableThreads: [],
        operations: [],
      },
    },
  );
  await app.open(page(gitlab, 10));
  await userEvent.click(await screen.findByRole("tab", { name: /^Timeline/ }));
  expect(await screen.findByRole("textbox", { name: "Comment" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Merge now/ })).toBeNull();
  expect(screen.queryByText(/Some review actions are available only/)).toBeNull();
});

test("an explicit empty capability list on GitHub hides files and write controls", async () => {
  const github = { ...gitlab, forge: "github", host: "github.com" } as const;
  const app = withDetails({ ...hosted(github, 11), capabilities: [] });
  await app.open(page(github, 11));
  await screen.findByText("Retry reconnects");
  expect(screen.queryByRole("tab", { name: /^Code/ })).toBeNull();
  expect(screen.queryByRole("tab", { name: /^Checks/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
});

function discussionDetail(capabilities: string[]) {
  const detail = hosted(gitlab, 12);
  const comment = {
    kind: "inline",
    id: 77,
    author: "reviewer",
    body: "Provider conversation text",
    file: "hosted-change.ts",
    line: 1,
    replyTo: null,
    updatedAt: "2026-11-10",
  };
  const old = {
    ...comment,
    id: 78,
    body: "Provider off-diff text",
    file: "removed.ts",
    line: null,
  };
  return ForgePrDetail.parse({
    ...detail,
    capabilities,
    status: {
      ...detail.status,
      comments: [comment, old],
      reviewThreads: [
        {
          id: "current",
          resolved: false,
          outdated: false,
          file: comment.file,
          line: 1,
          comments: [comment],
        },
        { id: "old", resolved: false, outdated: true, file: old.file, line: null, comments: [old] },
      ],
    },
  });
}

test.each([false, true])(
  "Code shows provider conversations only with comments.read, declared=%s",
  async (readable) => {
    const detail = discussionDetail([
      "reviews.read",
      "reviews.files",
      ...(readable ? ["reviews.comments.read"] : []),
    ]);
    const app = withDetails(detail);
    await app.open(`${page(gitlab, 12)}&tab=code`);
    await screen.findAllByText("hosted-change.ts");
    if (readable) {
      expect(await screen.findByText("Provider conversation text")).toBeTruthy();
      expect(await screen.findByText("Provider off-diff text")).toBeTruthy();
    } else {
      expect(screen.queryByText("Provider conversation text")).toBeNull();
      expect(screen.queryByText("Provider off-diff text")).toBeNull();
      expect(screen.queryByRole("button", { name: "Next comment" })).toBeNull();
      expect(screen.queryByText("Conversations not on the current diff")).toBeNull();
    }
  },
);

test.each([false, true])(
  "Timeline shows provider comments only with comments.read, declared=%s",
  async (readable) => {
    const app = withDetails(
      discussionDetail([
        "reviews.read",
        "reviews.comments.write",
        ...(readable ? ["reviews.comments.read"] : []),
      ]),
    );
    await app.open(`${page(gitlab, 12)}&tab=timeline`);
    const timeline = await screen.findByRole("region", { name: "Pull request timeline" });
    if (readable)
      expect(await within(timeline).findByText("Provider conversation text")).toBeTruthy();
    else {
      expect(await within(timeline).findByText("No activity yet.")).toBeTruthy();
      expect(within(timeline).queryByText("Provider conversation text")).toBeNull();
      expect(within(timeline).queryByText("Provider off-diff text")).toBeNull();
    }
  },
);

test.each(["checks", "timeline", "code"])(
  "a forced unsupported %s URL shows Summary and sends no section reads",
  async (tab) => {
    const app = withDetails({
      ...discussionDetail(["reviews.read"]),
      capabilities: ["reviews.read"],
    });
    const requests = vi.spyOn(app.client, "request");
    await app.open(`${page(gitlab, 12)}&tab=${tab}`);
    expect(await screen.findByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: new RegExp(`^${tab}`, "i") })).toBeNull();
    expect(screen.queryByRole("region", { name: "Pull request timeline" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Hosted PR diff" })).toBeNull();
    const sectionReads = requests.mock.calls.flatMap(([request]) =>
      request.type === "workspace.request" &&
      ["forge.pr.activity", "forge.pr.commits", "forge.pr.check", "forge.pr.files"].includes(
        request.operation.op,
      )
        ? [request.operation.op]
        : [],
    );
    expect(sectionReads).toEqual([]);
  },
);

test("an approvals-only host offers Approve and submits an approval without comment writing", async () => {
  const detail = {
    ...hosted(gitlab, 13),
    capabilities: ["reviews.read", "reviews.approvals.write"],
  };
  const app = withDetails(detail);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId, repository: gitlab, number: 13 },
    {
      resource: "prReviewState",
      value: {
        viewer: "me",
        headSha: detail.status.headSha,
        drafts: [],
        viewed: null,
        canReview: true,
        canComment: true,
        resolvableThreads: [],
        operations: [],
      },
    },
  );
  const commands = vi
    .spyOn(app.client, "command")
    .mockResolvedValue({ commandId: CommandId.parse("approval"), ok: true });
  await app.open(page(gitlab, 13));
  // Review is a disabled placeholder until the review state arrives, then a new button.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review" }).hasAttribute("disabled")).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(await screen.findByRole("radio", { name: "Approve", checked: true })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Comment" })).toBeNull();
  const submit = screen.getByRole("button", { name: "Submit review" });
  expect(submit.hasAttribute("disabled")).toBe(false);
  await userEvent.click(submit);
  await waitFor(() =>
    expect(
      commands.mock.calls.some(
        ([command]) =>
          command.type === "forge.hosted.review" &&
          command.action.kind === "submit" &&
          command.action.event === "APPROVE",
      ),
    ).toBe(true),
  );
});

test("autoMerge without merge reads its state and offers disabling an armed auto-merge", async () => {
  const detail = { ...hosted(gitlab, 14), capabilities: ["reviews.read", "reviews.autoMerge"] };
  const app = withDetails(detail);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.merge-state", workspaceId, repository: gitlab, number: 14 },
    {
      resource: "prMergeState",
      value: ForgeMergeState.parse({
        headSha: detail.status.headSha,
        state: "OPEN",
        mergeState: "BLOCKED",
        reviewDecision: null,
        checksState: "PENDING",
        autoMerge: { method: "SQUASH", actor: "me", enabledAt: "2026-11-10" },
        queue: null,
        canEnable: false,
        canDisable: true,
        canDequeue: false,
        blockers: [],
        raw: {},
      }),
    },
  );
  await app.open(page(gitlab, 14));
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  const disable = await screen.findByRole("menuitem", { name: "Disable auto-merge" });
  expect(disable.getAttribute("aria-disabled")).not.toBe("true");
  expect(screen.queryByRole("menuitem", { name: "Merge now" })).toBeNull();
});

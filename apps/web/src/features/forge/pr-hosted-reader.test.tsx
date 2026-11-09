import { expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgePrDetail, WorkspaceId, type ForgeRepository } from "@ace/protocol";
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
  patch: { title?: string; body?: string; changedFiles?: number; files?: boolean } = {},
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
  expect(await screen.findByText("hosted-change.ts")).toBeTruthy();
  expect(within(tabs).getByRole("tab", { name: /^Code/, selected: true })).toBeTruthy();
});

test("a merge request whose host reports its files lists them under Code with their count", async () => {
  const app = withDetails(hosted(gitlab, 9, { changedFiles: 3 }));
  await app.open(page(gitlab, 9));
  const tabs = await screen.findByRole("tablist", { name: "Merge request detail" });
  const code = within(tabs).getByRole("tab", { name: /^Code/ });
  expect(code.textContent).toBe("Code3");
  expect(screen.getByRole("link", { name: "Open on GitLab" })).toBeTruthy();
  await userEvent.click(code);
  expect(await screen.findByText("hosted-change.ts")).toBeTruthy();
});

test("a merge request whose host can't share its files says so instead of an empty list", async () => {
  const app = withDetails(hosted(gitlab, 9, { files: false, changedFiles: 0 }));
  await app.open(page(gitlab, 9));
  const tabs = await screen.findByRole("tablist", { name: "Merge request detail" });
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
  await waitFor(() => expect(within(next).getByText(/Read only in ace/)).toBeTruthy());
});

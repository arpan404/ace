import { expect, test } from "vitest";
import { isAdmittedWriteRequest, type HostApiWrite } from "./read-only-api.ts";
import { gitLabCreationWrites } from "./gitlab-creation.ts";
import { gitLabLifecycleWrites } from "./gitlab-lifecycle.ts";
import { gitLabChecksWrites } from "./gitlab-checks.ts";
import { gitlabIssueWrites } from "./gitlab-issue-writes.ts";
import { gitlabMergeWrites } from "./gitlab-merge-state.ts";
import { gitLabReviewWrites } from "./gitlab-reviews.ts";
import { teaWrites } from "./tea-writes.ts";
import { teaReviewWrites } from "./tea-reviews.ts";
import { teaIssueWrites } from "./tea-issue-writes.ts";

const gitlab = { forge: "gitlab" as const, host: "gitlab.com", owner: "team/sub", name: "app" };
const gitea = { forge: "gitea" as const, host: "git.example", owner: "team", name: "app" };
const project = "projects/team%2Fsub%2Fapp";
const other = "projects/team%2Fsub%2Fother";
const repo = "repos/team/app";
const elsewhere = "repos/team/other";

function admitted(
  cli: "glab" | "tea",
  writes: readonly HostApiWrite[],
  method: string,
  path: string,
) {
  const args =
    cli === "glab"
      ? ["api", path, "-X", method, "--hostname", "gitlab.com", "--include", "--input", "-"]
      : ["api", path, "--method", method, "--login", "work", "--include", "--data", "@-"];
  return isAdmittedWriteRequest(
    cli,
    { command: cli, args, input: "{}" },
    cli === "glab" ? "gitlab.com" : "work",
    writes,
  );
}

/** Each adapter's write, the same write in another repository, and on another PR where pinned. */
const cases: {
  name: string;
  cli: "glab" | "tea";
  writes: readonly HostApiWrite[];
  method: string;
  allowed: string[];
  refused: string[];
}[] = [
  {
    name: "GitLab MR creation in the target or its fork",
    cli: "glab",
    writes: gitLabCreationWrites(gitlab, { owner: "alice", name: "fork" }),
    method: "POST",
    allowed: [`${project}/merge_requests`, "projects/alice%2Ffork/merge_requests"],
    refused: [`${other}/merge_requests`, "projects/2/merge_requests"],
  },
  {
    name: "GitLab MR edits",
    cli: "glab",
    writes: gitLabLifecycleWrites(gitlab),
    method: "PUT",
    allowed: [`${project}/merge_requests/7`],
    refused: [`${other}/merge_requests/7`],
  },
  {
    name: "GitLab merges",
    cli: "glab",
    writes: gitlabMergeWrites(gitlab),
    method: "PUT",
    allowed: [`${project}/merge_requests/7/merge`],
    refused: [`${other}/merge_requests/7/merge`],
  },
  {
    name: "GitLab pipeline retries",
    cli: "glab",
    writes: gitLabChecksWrites(gitlab),
    method: "POST",
    allowed: [`${project}/pipelines/9/retry`, `${project}/jobs/3/retry`],
    refused: [`${other}/pipelines/9/retry`, `${other}/jobs/3/retry`],
  },
  {
    name: "GitLab issue writes",
    cli: "glab",
    writes: gitlabIssueWrites(gitlab),
    method: "POST",
    allowed: [`${project}/issues`, `${project}/issues/4/notes`],
    refused: [`${other}/issues`, `${other}/issues/4/notes`],
  },
  {
    name: "GitLab review writes on one MR",
    cli: "glab",
    writes: gitLabReviewWrites(gitlab, 7),
    method: "POST",
    allowed: [`${project}/merge_requests/7/notes`],
    refused: [`${other}/merge_requests/7/notes`, `${project}/merge_requests/8/notes`],
  },
  {
    name: "Gitea merges",
    cli: "tea",
    writes: teaWrites(gitea),
    method: "POST",
    allowed: [`${repo}/pulls/7/merge`],
    refused: [`${elsewhere}/pulls/7/merge`],
  },
  {
    name: "Gitea review writes on one PR",
    cli: "tea",
    writes: teaReviewWrites(gitea, 7),
    method: "POST",
    allowed: [`${repo}/issues/7/comments`, `${repo}/pulls/7/reviews`],
    refused: [
      `${elsewhere}/issues/7/comments`,
      `${repo}/issues/8/comments`,
      `${repo}/pulls/8/reviews`,
    ],
  },
  {
    name: "Gitea issue writes",
    cli: "tea",
    writes: teaIssueWrites(gitea),
    method: "POST",
    allowed: [`${repo}/issues`, `${repo}/issues/4/comments`],
    refused: [`${elsewhere}/issues`, `${elsewhere}/issues/4/comments`],
  },
];

test.each(cases)("$name are admitted only in their own repository", (each) => {
  for (const path of each.allowed)
    expect(admitted(each.cli, each.writes, each.method, path)).toBe(true);
  for (const path of each.refused)
    expect(admitted(each.cli, each.writes, each.method, path)).toBe(false);
});

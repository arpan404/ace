import type { ForgeBrowserResult, ForgeFile, WorkspaceActionRequest } from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

/*
 * A catalog pull request's code as the daemon reads it from GitHub: its commits, the files of
 * All commits, of one commit or of a span of commits, and a changed file read whole at a
 * commit. A commit outside the PR is not found, as GitHub's own check finds it.
 */

type Operation = WorkspaceActionRequest["operation"];
type FilesOp = Extract<Operation, { op: "forge.pr.files" }>;
type ContentOp = Extract<Operation, { op: "forge.file.content" }>;

export function commitsRead(fixture: PullRequestFixture): ForgeBrowserResult {
  return {
    resource: "prCommits",
    commits: (fixture.commits ?? []).map((entry) => entry.commit),
    truncated: false,
  };
}

export function filesRead(
  fixture: PullRequestFixture,
  op: FilesOp,
): ForgeBrowserResult | undefined {
  const { detail } = fixture;
  const all = {
    ref: detail.status.ref,
    baseSha: detail.baseSha,
    headSha: detail.status.headSha,
    files: fixture.files,
    truncated: false,
  };
  if (!op.commit) return op.since ? undefined : { resource: "prFiles", value: all };
  const commits = fixture.commits ?? [];
  const to = commits.findIndex((entry) => entry.commit.sha === op.commit);
  if (to < 0) return undefined;
  const from = op.since ? commits.findIndex((entry) => entry.commit.sha === op.since) : to - 1;
  if (op.since && (from < 0 || from >= to)) return undefined;
  // Each path as the newest commit of the span changed it.
  const files = new Map<string, ForgeFile>();
  for (const entry of commits.slice(from + 1, to + 1))
    for (const file of entry.files) files.set(file.path, file);
  return {
    resource: "prFiles",
    value: {
      ...all,
      baseSha: from < 0 ? detail.baseSha : (commits[from]?.commit.sha ?? detail.baseSha),
      headSha: op.commit,
      commit: op.commit,
      ...(op.since ? { since: op.since } : {}),
      files: [...files.values()],
    },
  };
}

/** A file at a commit: the newest version at or before it, by the PR's commit order. */
export function contentRead(
  fixtures: readonly PullRequestFixture[],
  op: ContentOp,
): ForgeBrowserResult | undefined {
  for (const fixture of fixtures) {
    const known = fixture.contents?.find((entry) => entry.path === op.path);
    if (!known) continue;
    const order = [fixture.detail.baseSha, ...(fixture.commits ?? []).map((c) => c.commit.sha)];
    const at = order.indexOf(op.sha);
    if (at < 0) continue;
    const version = known.versions
      .filter((each) => order.indexOf(each.sha) <= at && order.includes(each.sha))
      .at(-1);
    return {
      resource: "fileContent",
      value: version?.content ?? { kind: "missing" },
    };
  }
  return undefined;
}

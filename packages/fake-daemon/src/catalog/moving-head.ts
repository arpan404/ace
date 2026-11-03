import type { ForgeFile, ForgeFileContent } from "@ace/protocol";
import { followLines, type Comparison } from "@ace/forge/review-draft-move";
import { diffHunk, unifiedPatch } from "./line-diff.ts";
import type { FixtureCommit, PullRequestFixture } from "./pull-request-details.ts";

/*
 * A sample pull request whose every file is kept whole at its base and at each commit that
 * changed it (`contents`), so a push can be played on it as GitHub would show one: a new head,
 * patches worked out again, conversations on changed lines outdated and the rest moved with
 * their lines. Pending drafts stay on the commit they were written on.
 */

type ForgeReviewThread = PullRequestFixture["detail"]["status"]["reviewThreads"][number];

/** One commit pushed to the PR's branch: what it says and how it changes each file it touches. */
export interface Push {
  sha: string;
  message: string;
  author: string;
  at: string;
  edits: ReadonlyMap<string, (lines: string[]) => string[]>;
}

/** A file's lines as GitHub serves the whole file. */
export const wholeFile = (lines: readonly string[]): ForgeFileContent => {
  const body = lines.length ? `${lines.join("\n")}\n` : "";
  return { kind: "text", text: body, size: body.length };
};
const lines = (content: ForgeFileContent): string[] | null =>
  content.kind === "text" ? content.text.replace(/\n$/, "").split("\n") : null;

/** The PR's commits, base first: the order its file versions are read in. */
function order(fixture: PullRequestFixture): string[] {
  return [fixture.detail.baseSha, ...(fixture.commits ?? []).map((c) => c.commit.sha)];
}

/** File `path` at commit `sha` of the PR, or null where it doesn't exist (or isn't known). */
export function linesAt(fixture: PullRequestFixture, path: string, sha: string): string[] | null {
  const shas = order(fixture);
  const at = shas.indexOf(sha);
  const known = fixture.contents?.find((entry) => entry.path === path);
  if (at < 0 || !known) return null;
  const version = known.versions.findLast((each) => {
    const index = shas.indexOf(each.sha);
    return index >= 0 && index <= at;
  });
  return version ? lines(version.content) : null;
}

/** A changed file of a patch between two versions of it. */
function changedFile(path: string, before: string[] | null, after: string[] | null): ForgeFile {
  const diff = unifiedPatch(before ?? [], after ?? []);
  return {
    path,
    status: before === null ? "added" : after === null ? "removed" : "modified",
    additions: diff.additions,
    deletions: diff.deletions,
    patch: diff.patch,
    truncated: false,
  };
}

/** Every file that differs between commits `from` and `to`, as `path`-sorted changed files. */
function changes(fixture: PullRequestFixture, from: string, to: string): ForgeFile[] {
  return (fixture.contents ?? []).flatMap(({ path }) => {
    const before = linesAt(fixture, path, from);
    const after = linesAt(fixture, path, to);
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [changedFile(path, before, after)];
  });
}

/** GitHub's comparison of `from` (a commit of the PR, or not) with the PR's head. */
export function comparison(fixture: PullRequestFixture, from: string): Comparison {
  const descends = order(fixture).includes(from);
  return {
    descends,
    merges: false,
    complete: true,
    files: descends
      ? changes(fixture, from, fixture.detail.status.headSha).map((file) => ({
          path: file.path,
          status: file.status,
          patch: file.patch ?? undefined,
        }))
      : [],
  };
}

/**
 * A conversation on new-side `line` (through `startLine`) at the PR's head, carrying the hunk,
 * line and commit GitHub records it was written on.
 */
export function threadAt(
  fixture: PullRequestFixture,
  place: { id: string; path: string; line: number; startLine?: number; resolved?: boolean },
  comments: ForgeReviewThread["comments"],
): ForgeReviewThread {
  const patch = fixture.files.find((file) => file.path === place.path)?.patch ?? "";
  const hunk = diffHunk(patch, place.line);
  return {
    id: place.id,
    resolved: place.resolved ?? false,
    outdated: false,
    file: place.path,
    line: place.line,
    side: "RIGHT",
    startLine: place.startLine ?? null,
    ...(hunk ? { hunk } : {}),
    originalLine: place.line,
    originalStartLine: place.startLine ?? null,
    originalCommit: fixture.detail.status.headSha,
    comments,
  };
}

/** A conversation after a commit changed its file: moved with its lines, or outdated. */
function followed(thread: ForgeReviewThread, patch: string | null): ForgeReviewThread {
  if (thread.outdated || thread.side === "LEFT" || thread.line === null || patch === null)
    return thread;
  const start = thread.startLine ?? thread.line;
  const span = followLines(patch, start, thread.line);
  if (!span) return { ...thread, outdated: true, line: null, startLine: null };
  return {
    ...thread,
    line: span.end,
    startLine: thread.startLine == null ? thread.startLine : span.start,
  };
}

/** The PR after `push` lands on its branch, as every later read shows it. */
export function pushHead(fixture: PullRequestFixture, push: Push): PullRequestFixture {
  const { detail } = fixture;
  const before = detail.status.headSha;
  const contents = [...(fixture.contents ?? [])];
  const touched: ForgeFile[] = [];
  for (const [path, edit] of push.edits) {
    const was = linesAt(fixture, path, before);
    const now = edit([...(was ?? [])]);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    touched.push(changedFile(path, was, now));
    const at = contents.findIndex((entry) => entry.path === path);
    const version = { sha: push.sha, content: wholeFile(now) };
    if (at < 0)
      contents.push({
        path,
        versions: [{ sha: detail.baseSha, content: { kind: "missing" } }, version],
      });
    else {
      const entry = contents[at];
      if (entry) contents[at] = { path, versions: [...entry.versions, version] };
    }
  }
  const commit: FixtureCommit = {
    commit: {
      sha: push.sha,
      message: push.message,
      author: push.author,
      authorAvatarUrl: `https://avatars.githubusercontent.com/${push.author}`,
      additions: touched.reduce((sum, file) => sum + file.additions, 0),
      deletions: touched.reduce((sum, file) => sum + file.deletions, 0),
      date: push.at,
      url: `${detail.status.url}/commits/${push.sha}`,
    },
    files: touched,
  };
  const commits = [...(fixture.commits ?? []), commit];
  const moved: PullRequestFixture = { ...fixture, contents, commits };
  const files = changes(moved, detail.baseSha, push.sha);
  const patches = new Map(touched.map((file) => [file.path, file.patch]));
  const headSha = push.sha;
  return {
    ...moved,
    files,
    detail: {
      ...detail,
      updatedAt: push.at,
      commits: commits.length,
      changedFiles: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      status: {
        ...detail.status,
        headSha,
        reviewThreads: detail.status.reviewThreads.map((thread) =>
          followed(thread, patches.get(thread.file) ?? null),
        ),
      },
    },
    ...(fixture.mergeState ? { mergeState: { ...fixture.mergeState, headSha } } : {}),
    lifecycle: { ...fixture.lifecycle, snapshot: { ...fixture.lifecycle.snapshot, headSha } },
    review: { ...fixture.review, headSha },
  };
}

/** A stable 40-hex commit id for `seed`, so the same push always makes the same commit. */
export function fakeSha(seed: string): string {
  let out = "";
  let hash = 0x811c9dc5;
  for (let round = 0; out.length < 40; round++) {
    for (const char of `${seed}:${round}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

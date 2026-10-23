import {
  ForgeCompare,
  ForgeNewPrContext,
  type ForgeCommit,
  type ForgeCompareHead,
  type ForgeRepository,
} from "@ace/protocol";
import { file } from "./pull-request-details.ts";

/*
 * The fake GitHub's side of a new pull request in `acme/ace`: its branches, its template, and
 * what each branch would bring into a base.
 */

const repository: ForgeRepository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "ace",
};
const minute = 60_000;
/** A stable 40-hex commit id per seed (FNV-1a, repeated with a salt). */
const sha = (seed: string) => {
  let out = "";
  for (let salt = 0; out.length < 40; salt++) {
    let hash = 0x811c9dc5;
    for (const char of `${salt}:${seed}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
};

/** Branches that have no pull request yet, with the commits and files each would bring. */
const unpublished: Record<
  string,
  { commits: { message: string; author: string }[]; files: [string, number, number][] }
> = {
  "feature/release-notes": {
    commits: [
      { message: "Add a release notes page", author: "you" },
      {
        message: "Group release notes by version\n\nNewest first, each version folded.",
        author: "you",
      },
      { message: "Link release notes from Settings", author: "dana" },
    ],
    files: [
      ["apps/web/src/features/settings/release-notes-page.tsx", 142, 0],
      ["apps/web/src/features/settings/settings-nav.tsx", 6, 1],
      ["apps/web/src/routes/_home.settings.release-notes.tsx", 18, 0],
      ["docs/release-notes.md", 40, 0],
    ],
  },
  "fix/tooltip-delay": {
    commits: [{ message: "Wait 400ms before showing tooltips", author: "mira" }],
    files: [["apps/web/src/components/ui/tooltip.tsx", 3, 2]],
  },
};

const template = [
  "## Summary",
  "",
  "<!-- What changes for the person using ace. -->",
  "",
  "## How it was checked",
  "",
  "- [ ] Tests",
  "- [ ] Checked in the app",
].join("\n");

/** Where a new PR of the fake project opens and from which branches. */
export function newPrContext(prBranches: readonly string[]): ForgeNewPrContext {
  const names = ["main", "release/0.0.8", ...Object.keys(unpublished), ...prBranches];
  const branches = [...new Set(names)].map((name) => ({ name, sha: sha(name) }));
  return ForgeNewPrContext.parse({
    base: { repository, defaultBranch: "main", branches, truncated: false },
    head: { repository, branches, truncated: false },
    template,
  });
}

/**
 * What `head` would bring into `base`: an unpublished branch's own commits, a PR branch's files,
 * and nothing between a branch and itself or the release branch.
 */
export function compareBranches(
  now: number,
  base: string,
  head: ForgeCompareHead,
  page: number,
  prFiles: (branch: string) => [string, number, number][] | undefined,
  prTitle: (branch: string) => string | undefined,
): ForgeCompare {
  const known = unpublished[head.branch];
  const fromPr = prFiles(head.branch);
  const identical = head.branch === base || (!known && !fromPr);
  const commits: ForgeCommit[] = identical
    ? []
    : (known?.commits ?? [{ message: prTitle(head.branch) ?? head.branch, author: "you" }]).map(
        (commit, index, all) => ({
          sha: sha(`${head.branch}${index}`),
          message: commit.message,
          author: commit.author,
          date: new Date(now - (all.length - index) * 37 * minute).toISOString(),
          url: `https://github.com/acme/ace/commit/${sha(`${head.branch}${index}`)}`,
        }),
      );
  const files = identical ? [] : (known?.files ?? fromPr ?? []);
  const first = (page - 1) * 25;
  return ForgeCompare.parse({
    base,
    head,
    status: identical ? "identical" : "ahead",
    aheadBy: commits.length,
    behindBy: 0,
    mergeBaseSha: sha(base),
    headSha: commits.at(-1)?.sha ?? sha(base),
    commits,
    totalCommits: commits.length,
    files: files
      .slice(first, first + 25)
      .map(([path, add, del]) => file(path, add, del, del ? "modified" : "added")),
    totalFiles: files.length,
    ...(first + 25 < files.length ? { nextPage: page + 1 } : {}),
    truncated: false,
  });
}

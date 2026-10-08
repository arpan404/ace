import { ForgePrStatus } from "@ace/protocol";

const minute = 60_000;
const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();

function pr(
  number: number,
  title: string,
  patch: Partial<Omit<ForgePrStatus, "ref" | "title" | "url">> & {
    repository?: ForgePrStatus["ref"]["repository"];
  },
): ForgePrStatus {
  const { repository: repo = repository, ...rest } = patch;
  return ForgePrStatus.parse({
    ref: { repository: repo, number },
    title,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
    headSha: number.toString(16).padStart(40, "c"),
    state: "open",
    mergeability: "mergeable",
    ci: "none",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
    ...rest,
  });
}

const check = (name: string, status: "success" | "failure", completedAt: number) => ({
  id: name,
  name,
  status,
  conclusion: status,
  completedAt: iso(completedAt),
  jobId: null,
  url: null,
});

/**
 * Pull requests linked to the design's threads: one with failing checks, one with a question
 * for you in review, one merged. The Activity feed reads them through `pr.status`.
 */
export function pullRequests(now: number): Record<string, ForgePrStatus> {
  return {
    "thread-pdf-locale": pr(74, "Invoice PDF locale fallback", {
      repository: { forge: "github", host: "github.com", owner: "acme", name: "billing-api" },
      ci: "failure",
      checks: [
        check("lint", "success", now - 28 * minute),
        check("test (pdf)", "failure", now - 26 * minute),
        check("test (locale)", "failure", now - 26 * minute),
      ],
    }),
    "thread-install-page": pr(31, "Rewrite the install page for the daemon", {
      repository: { forge: "github", host: "github.com", owner: "acme", name: "docs-site" },
      comments: [
        {
          kind: "inline",
          id: 1,
          body: "@you Which port does the daemon default to in docker?",
          author: "mira",
          file: "docs/install.md",
          line: 12,
          updatedAt: iso(now - 31 * minute),
          replyTo: null,
        },
      ],
    }),
    "thread-bump-codex": pr(212, "Bump Codex app-server to 0.48", {
      state: "merged",
      ci: "success",
    }),
  };
}

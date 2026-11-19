import { ForgePrDetail, type ForgeComment } from "@ace/protocol";
import { addedSource, baseSource, streamed } from "./ledger-sources.ts";
import { fakeSha, pushHead, threadAt, wholeFile, type Push } from "./moving-head.ts";
import {
  check,
  lifecycle,
  mergeState,
  review,
  type PullRequestFixture,
} from "./pull-request-details.ts";

/*
 * A big pull request whose head moves while it is reviewed: 62 files over three file pages,
 * patches worked out from whole files, conversations on current lines and two that an earlier
 * push outdated, pending drafts, and a review pending on GitHub. Each further push (`nextPush`)
 * shifts the lines under one draft and edits the line of another, as a teammate's push would.
 */

const minute = 60_000;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const number = 250;
const url = `https://github.com/acme/ace/pull/${number}`;
const author = "dana";
const areas = ["accounts", "exports", "imports", "ledger", "reports", "streams"];
const names = [
  "account-stream",
  "balance",
  "cursor",
  "entries",
  "merge",
  "order",
  "replay",
  "snapshot",
  "totals",
  "window",
];
/** The file every push adds lines near the top of, and the one whose draft line it edits. */
const shifted = "packages/ledger/src/streams/account-stream.ts";
const edited = "packages/ledger/src/streams/cursor.ts";
const kept = "packages/ledger/src/streams/order.ts";
/** Two files whose conversations the last push outdated. */
const outdatedFiles = [
  "packages/ledger/src/streams/balance.ts",
  "packages/ledger/src/ledger/merge.ts",
];

const pathsOf = () =>
  areas.flatMap((area) =>
    names.map((name) => ({ area, name, path: `packages/ledger/src/${area}/${name}.ts` })),
  );
const tests = ["packages/ledger/test/streams.test.ts", "packages/ledger/test/replay.test.ts"];

const comment = (
  id: number,
  who: string,
  path: string,
  line: number | null,
  at: number,
  body: string,
  replyTo: number | null = null,
): ForgeComment => ({
  kind: "inline",
  id,
  body,
  author: who,
  authorAvatarUrl: `https://avatars.githubusercontent.com/${who}`,
  file: path,
  line,
  createdAt: iso(at),
  updatedAt: iso(at),
  replyTo,
});

/** A line edit: line `line` (1-based) gains a note, so its text changes. */
const touchLine = (line: number, note: string) => (lines: string[]) =>
  lines.map((text, at) => (at === line - 1 ? `${text} // ${note}` : text));
/** The same edit on every line that reads `match`. */
const touchText = (match: string, note: string) => (lines: string[]) =>
  lines.map((text) => (text === match ? `${text} // ${note}` : text));

/** The pull request before any reviewer arrived: base, then its first two commits. */
function opened(now: number): PullRequestFixture {
  const baseSha = fakeSha("ledger-base");
  const paths = pathsOf();
  const detail = ForgePrDetail.parse({
    status: {
      ref: { repository, number },
      title: "Stream ledger entries one account at a time",
      url,
      headSha: baseSha,
      state: "open",
      mergeability: "mergeable",
      ci: "pending",
      checks: [
        check("lint", "success", now - 9 * minute),
        check("typecheck", "success", now - 8 * minute),
        check("test (ledger)", "pending", now),
      ],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: [
      "Every ledger module now walks entries one account at a time, oldest first, so exports",
      "and reports stop interleaving accounts. Adds a replay module per area.",
      "",
      "Large on purpose: the same change lands in all six areas.",
    ].join("\n"),
    author,
    createdAt: iso(now - 6 * 60 * minute),
    updatedAt: iso(now - 6 * 60 * minute),
    additions: 0,
    deletions: 0,
    headBranch: "ledger/account-streams",
    baseBranch: "main",
    baseSha,
    headRepository: repository,
    labels: ["ledger"],
    reviewers: ["mira", "sam", "you"],
    reviewDecision: null,
    commits: 0,
    changedFiles: 0,
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
  const fixture: PullRequestFixture = {
    detail,
    mergeState: mergeState(baseSha, { reviewDecision: "REVIEW_REQUIRED", checksState: "PENDING" }),
    lifecycle: lifecycle(detail, ["draft", "close"]),
    review: review(baseSha, true, { detail }),
    files: [],
    activity: [],
    commits: [],
    contents: [
      ...paths.map(({ area, name, path }, index) => ({
        path,
        versions: [
          {
            sha: baseSha,
            content:
              name === "replay"
                ? { kind: "missing" as const }
                : wholeFile(baseSource(area, name, index)),
          },
        ],
      })),
      ...tests.map((path) => ({
        path,
        versions: [{ sha: baseSha, content: { kind: "missing" as const } }],
      })),
    ],
  };
  const first = pushHead(fixture, {
    sha: fakeSha("ledger-1"),
    message: "Stream ledger entries one account at a time",
    author,
    at: iso(now - 5 * 60 * minute),
    edits: new Map([
      ...paths.map(
        ({ area, name, path }) =>
          [
            path,
            (lines: string[]) =>
              name === "replay" ? addedSource(area, name) : streamed(lines, area),
          ] as const,
      ),
      ...tests.map(
        (path) =>
          [
            path,
            () => [
              'import { expect, test } from "vitest";',
              "",
              `test("${path.includes("replay") ? "replay" : "streams"} keep each account's entries together", () => {`,
              "  expect(true).toBe(true);",
              "});",
            ],
          ] as const,
      ),
    ]),
  });
  return pushHead(first, {
    sha: fakeSha("ledger-2"),
    message: "Say what each total counts in",
    author,
    at: iso(now - 3 * 60 * minute),
    edits: new Map(
      paths
        .filter(({ area }) => area === "reports")
        .map(({ path }) => [path, touchText("  let sum = 0;", "cents")] as const),
    ),
  });
}

/** The PR as the fake app opens it: reviewed, pushed to since, with drafts and a pending review. */
export function movingPullRequest(now: number): PullRequestFixture {
  const before = opened(now);
  const [balance = "", merge = ""] = outdatedFiles;
  const question = comment(
    2501,
    "mira",
    balance,
    18,
    now - 150 * minute,
    "Does `seen` need to reset per page?",
  );
  const repeat = comment(
    2502,
    "sam",
    merge,
    19,
    now - 140 * minute,
    "Two merges can add the same account here.",
  );
  const answer = comment(2503, author, merge, 19, now - 130 * minute, "Good catch, fixing.", 2502);
  const early = [question, repeat, answer];
  const withEarly = {
    ...before,
    detail: {
      ...before.detail,
      status: {
        ...before.detail.status,
        comments: early,
        reviewThreads: [
          threadAt(before, { id: "RT_2501", path: balance, line: 18 }, [question]),
          threadAt(before, { id: "RT_2502", path: merge, line: 19 }, [repeat, answer]),
        ],
      },
    },
  };
  // The push that answered them: both lines changed, so their conversations are outdated.
  const pushed = pushHead(withEarly, {
    sha: fakeSha("ledger-3"),
    message: "Reset the seen accounts per page; skip repeated merges",
    author,
    at: iso(now - 90 * minute),
    edits: new Map([
      [balance, touchLine(18, "per page")],
      [merge, touchLine(19, "once per merge")],
    ]),
  });
  const sorting = comment(
    2511,
    "mira",
    shifted,
    16,
    now - 40 * minute,
    "Sorting copies every entry; fine at this size?",
  );
  const order = comment(
    2512,
    "sam",
    edited,
    15,
    now - 35 * minute,
    "`a.at - b.at` breaks for equal times across accounts.",
  );
  const naming = comment(
    2513,
    "ola",
    kept,
    20,
    now - 30 * minute,
    "Nit: `kept` reads oddly next to `seen`.",
  );
  const current = [sorting, order, naming];
  const threads: PullRequestFixture["detail"]["status"]["reviewThreads"] = [
    ...pushed.detail.status.reviewThreads,
    threadAt(pushed, { id: "RT_2511", path: shifted, line: 16 }, [sorting]),
    threadAt(pushed, { id: "RT_2512", path: edited, line: 15 }, [order]),
    threadAt(pushed, { id: "RT_2513", path: kept, line: 20, resolved: true }, [naming]),
  ];
  const headSha = pushed.detail.status.headSha;
  const detail = {
    ...pushed.detail,
    status: {
      ...pushed.detail.status,
      comments: [...pushed.detail.status.comments, ...current],
      reviewThreads: threads,
    },
  };
  return {
    ...pushed,
    detail,
    review: {
      ...review(headSha, true, {
        detail,
        drafts: [
          {
            id: "draft-shift",
            body: "Skipping here drops the account's later entries too; is that intended?",
            anchor: { commit: headSha, path: shifted, line: 18, side: "RIGHT" },
          },
          {
            id: "draft-edit",
            body: "Sort by account first, then time, so equal times stay stable.",
            anchor: { commit: headSha, path: edited, line: 15, side: "RIGHT" },
          },
          {
            id: "draft-keep",
            body: "These two lines could be one `if (!seen.add(...))` helper.",
            anchor: { commit: headSha, path: kept, line: 19, side: "RIGHT", startLine: 18 },
          },
        ],
      }),
      hostedPending: { id: "PRR_fake", comments: 2, url: `${url}/files` },
    },
    nextPush,
  };
}

/**
 * A teammate's next push: three lines near the top of the shifted file move everything under
 * them down, and the line of the first other draft written on the head is edited. The rest of
 * the files stay as they were.
 */
function nextPush(fixture: PullRequestFixture, at: string): PullRequestFixture {
  const count = (fixture.commits ?? []).length + 1;
  const sha = fakeSha(`ledger-${count}`);
  const { headSha } = fixture.detail.status;
  const target = fixture.review.drafts.find(
    (draft) => draft.anchor.commit === headSha && draft.anchor.path !== shifted,
  )?.anchor ?? { path: edited, line: 20 };
  const push: Push = {
    sha,
    message: `Tidy the account streams (push ${count})`,
    author,
    at,
    edits: new Map([
      [
        shifted,
        (lines: string[]) => {
          lines.splice(
            2,
            0,
            `import { mark${count} } from "./marks.ts";`,
            `// Push ${count}: marks each account as its stream starts.`,
            `const marked${count} = mark${count}();`,
          );
          return lines;
        },
      ],
      [target.path, touchLine(target.line, `push ${count}`)],
    ]),
  };
  return pushHead(fixture, push);
}
